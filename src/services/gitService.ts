import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

export interface RepoData {
    tempDir: string;
    repoName: string;
}

export interface CodeFile {
    filePath: string;
    relativePath: string;
    content: string;
    extension: string;
    size: number;
}

export class GitService {
    // Use shorter path to avoid Windows path length issues
    private readonly tempBaseDir = path.join(os.tmpdir(), 'cr'); // Shortened from 'code-reviewer'
    private readonly maxRepoSize = 500 * 1024 * 1024; // Increased to 500MB for larger repos
    private readonly maxFileSize = 2 * 1024 * 1024; // 2MB max file size
    private readonly supportedExtensions = [
        '.js', '.jsx', '.ts', '.tsx',
        '.py', '.java', '.cpp', '.c', '.h',
        '.go', '.rs', '.php', '.rb',
        '.swift', '.kt', '.scala', '.cs',
        '.html', '.css', '.scss', '.less',
        '.vue', '.svelte', '.json', '.yaml', '.yml'
    ];

    constructor() {
        // Ensure temp directory exists
        fs.ensureDirSync(this.tempBaseDir);
    }

    async cloneRepository(repositoryUrl: string): Promise<RepoData> {
        // Use shorter UUID for temp directory names
        const shortId = uuidv4().split('-')[0]; // Use only first part of UUID
        const tempDir = path.join(this.tempBaseDir, shortId);

        try {
            await fs.ensureDir(tempDir);

            // Extract repository name from URL
            const repoName = this.extractRepoName(repositoryUrl);

            console.log(`🔄 Cloning repository: ${repositoryUrl}`);

            // Configure git for this clone operation
            const git = simpleGit();
            
            // Clone with options to handle large repos and long paths
            await git.clone(repositoryUrl, tempDir, [
                '--depth', '1',
                '--single-branch',
                '--config', 'core.longpaths=true',
                '--config', 'core.autocrlf=false',
                '--filter=blob:limit=10m' // Skip files larger than 10MB during clone
            ]);

            // Check repository size after clone
            const repoSize = await this.getDirectorySize(tempDir);
            console.log(`📊 Repository size: ${Math.round(repoSize / 1024 / 1024)}MB`);

            if (repoSize > this.maxRepoSize) {
                await this.cleanup(tempDir);
                throw new Error(`Repository is too large (${Math.round(repoSize / 1024 / 1024)}MB). Maximum size allowed is ${Math.round(this.maxRepoSize / 1024 / 1024)}MB.`);
            }

            console.log(`✅ Repository cloned successfully: ${repoName}`);

            return {
                tempDir,
                repoName
            };

        } catch (error: any) {
            // Clean up on error
            await this.cleanup(tempDir);

            if (error.message.includes('not found') || error.message.includes('does not exist')) {
                throw new Error('Repository not found or not accessible. Please check the URL and ensure the repository is public.');
            }

            if (error.message.includes('Filename too long') || error.message.includes('unable to create file')) {
                throw new Error('Repository contains files with paths that are too long for your system. This is a Windows limitation. Please enable long path support or try a smaller repository.');
            }

            if (error.message.includes('checkout failed')) {
                throw new Error('Repository checkout failed, likely due to long file paths. Please enable Windows long path support.');
            }

            throw new Error(`Failed to clone repository: ${error.message}`);
        }
    }

    async getCodeFiles(repoDir: string): Promise<CodeFile[]> {
        const codeFiles: CodeFile[] = [];
        const ignorePaths = [
            '.git', 'node_modules', 'dist', 'build', '.next',
            'target', 'vendor', '__pycache__', '.venv', 'venv',
            'coverage', '.nyc_output', 'logs', '*.log',
            'test', 'tests', '__tests__', 'spec', 'specs',
            'fixtures', 'mock', 'mocks','package-lock.json'
        ];

        try {
            await this.walkDirectory(repoDir, repoDir, codeFiles, ignorePaths);

            // Filter out files that are too large or have problematic paths
            const filteredFiles = codeFiles.filter(file => {
                if (file.size > this.maxFileSize) {
                    console.log(`⚠️  Skipping large file: ${file.relativePath} (${Math.round(file.size / 1024)}KB)`);
                    return false;
                }
                
                // Skip files with very long paths
                if (file.filePath.length > 240) {
                    console.log(`⚠️  Skipping file with long path: ${file.relativePath}`);
                    return false;
                }
                
                return true;
            });

            // Sort files by path for consistent ordering
            filteredFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

            // Limit total number of files to analyze (for performance)
            const maxFiles = 200;
            const finalFiles = filteredFiles.slice(0, maxFiles);
            
            if (filteredFiles.length > maxFiles) {
                console.log(`⚠️  Repository has ${filteredFiles.length} files. Analyzing first ${maxFiles} files.`);
            }

            console.log(`📁 Found ${finalFiles.length} code files to analyze`);

            return finalFiles;

        } catch (error: any) {
            throw new Error(`Failed to read code files: ${error.message}`);
        }
    }

    private async walkDirectory(
        currentPath: string,
        basePath: string,
        codeFiles: CodeFile[],
        ignorePaths: string[]
    ): Promise<void> {
        try {
            const items = await fs.readdir(currentPath);

            for (const item of items) {
                const fullPath = path.join(currentPath, item);
                const relativePath = path.relative(basePath, fullPath);

                // Skip ignored paths
                if (this.shouldIgnorePath(relativePath, ignorePaths)) {
                    continue;
                }

                // Skip if path is getting too long
                if (fullPath.length > 240) {
                    continue;
                }

                try {
                    const stat = await fs.stat(fullPath);

                    if (stat.isDirectory()) {
                        // Limit recursion depth to avoid very deep nesting
                        const depth = relativePath.split(path.sep).length;
                        if (depth < 10) {
                            await this.walkDirectory(fullPath, basePath, codeFiles, ignorePaths);
                        }
                    } else if (stat.isFile()) {
                        const extension = path.extname(item).toLowerCase();

                        // Only process supported file types
                        if (this.supportedExtensions.includes(extension)) {
                            // Skip files that are too large
                            if (stat.size > this.maxFileSize) {
                                continue;
                            }

                            try {
                                const content = await fs.readFile(fullPath, 'utf8');

                                codeFiles.push({
                                    filePath: fullPath,
                                    relativePath: relativePath.replace(/\\/g, '/'), // Normalize path separators
                                    content,
                                    extension,
                                    size: stat.size
                                });
                            } catch (error) {
                                // Skip files that can't be read (binary, permission issues, etc.)
                                console.log(`⚠️  Skipping unreadable file: ${relativePath}`);
                            }
                        }
                    }
                } catch (statError) {
                    // Skip files/directories that can't be accessed
                    continue;
                }
            }
        } catch (readdirError) {
            // Skip directories that can't be read
            console.log(`⚠️  Skipping unreadable directory: ${path.relative(basePath, currentPath)}`);
        }
    }

    private shouldIgnorePath(relativePath: string, ignorePaths: string[]): boolean {
        const pathParts = relativePath.split(path.sep);

        return ignorePaths.some(ignorePath => {
            if (ignorePath.includes('*')) {
                // Handle wildcard patterns
                const pattern = ignorePath.replace(/\*/g, '.*');
                return new RegExp(pattern).test(relativePath);
            }

            // Check if any part of the path matches ignore patterns
            return pathParts.some(part => part === ignorePath) || relativePath.startsWith(ignorePath);
        });
    }

    private extractRepoName(url: string): string {
        const match = url.match(/\/([^\/]+)\.git$/) || url.match(/\/([^\/]+)\/?$/);
        return match ? match[1] : 'unknown-repo';
    }

    private async getDirectorySize(dirPath: string): Promise<number> {
        let totalSize = 0;

        try {
            const items = await fs.readdir(dirPath);

            for (const item of items) {
                const fullPath = path.join(dirPath, item);
                
                try {
                    const stat = await fs.stat(fullPath);

                    if (stat.isDirectory()) {
                        totalSize += await this.getDirectorySize(fullPath);
                    } else {
                        totalSize += stat.size;
                    }
                } catch (error) {
                    // Skip files/directories that can't be accessed
                    continue;
                }
            }
        } catch (error) {
            // Return current size if directory can't be read
            return totalSize;
        }

        return totalSize;
    }

    async cleanup(tempDir: string): Promise<void> {
        try {
            if (await fs.pathExists(tempDir)) {
                // On Windows, sometimes files are locked, so retry cleanup
                let attempts = 0;
                const maxAttempts = 3;
                
                while (attempts < maxAttempts) {
                    try {
                        await fs.remove(tempDir);
                        console.log(`🧹 Cleaned up temporary directory: ${tempDir}`);
                        break;
                    } catch (error: any) {
                        attempts++;
                        if (attempts >= maxAttempts) {
                            console.error(`Failed to cleanup directory ${tempDir} after ${maxAttempts} attempts:`, error.message);
                        } else {
                            // Wait a bit before retrying
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Failed to cleanup directory ${tempDir}:`, error);
        }
    }
}