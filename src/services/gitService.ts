import simpleGit from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
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
    private readonly tempBaseDir = path.join(process.cwd(), 'temp');
    private readonly maxRepoSize = 100 * 1024 * 1024; // 100MB limit for MVP
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
        const tempDir = path.join(this.tempBaseDir, uuidv4());

        try {
            await fs.ensureDir(tempDir);

            // Extract repository name from URL
            const repoName = this.extractRepoName(repositoryUrl);

            console.log(`🔄 Cloning repository: ${repositoryUrl}`);

            // Clone with shallow depth to save time and space
            const git = simpleGit();
            await git.clone(repositoryUrl, tempDir, ['--depth', '1', '--single-branch']);

            // Check repository size
            const repoSize = await this.getDirectorySize(tempDir);
            if (repoSize > this.maxRepoSize) {
                await this.cleanup(tempDir);
                throw new Error(`Repository is too large (${Math.round(repoSize / 1024 / 1024)}MB). Maximum size allowed is 100MB.`);
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

            throw new Error(`Failed to clone repository: ${error.message}`);
        }
    }

    async getCodeFiles(repoDir: string): Promise<CodeFile[]> {
        const codeFiles: CodeFile[] = [];
        const ignorePaths = [
            '.git', 'node_modules', 'dist', 'build', '.next',
            'target', 'vendor', '__pycache__', '.venv', 'venv',
            'coverage', '.nyc_output', 'logs', '*.log'
        ];

        try {
            await this.walkDirectory(repoDir, repoDir, codeFiles, ignorePaths);

            // Sort files by path for consistent ordering
            codeFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

            console.log(`📁 Found ${codeFiles.length} code files`);

            return codeFiles;

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
        const items = await fs.readdir(currentPath);

        for (const item of items) {
            const fullPath = path.join(currentPath, item);
            const relativePath = path.relative(basePath, fullPath);

            // Skip ignored paths
            if (this.shouldIgnorePath(relativePath, ignorePaths)) {
                continue;
            }

            const stat = await fs.stat(fullPath);

            if (stat.isDirectory()) {
                await this.walkDirectory(fullPath, basePath, codeFiles, ignorePaths);
            } else if (stat.isFile()) {
                const extension = path.extname(item).toLowerCase();

                // Only process supported file types
                if (this.supportedExtensions.includes(extension)) {
                    // Skip files that are too large (> 1MB)
                    if (stat.size > 1024 * 1024) {
                        console.log(`⚠️  Skipping large file: ${relativePath} (${Math.round(stat.size / 1024)}KB)`);
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
                        console.log(`⚠️  Skipping unreadable file: ${relativePath}`);
                    }
                }
            }
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

        const items = await fs.readdir(dirPath);

        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const stat = await fs.stat(fullPath);

            if (stat.isDirectory()) {
                totalSize += await this.getDirectorySize(fullPath);
            } else {
                totalSize += stat.size;
            }
        }

        return totalSize;
    }

    async cleanup(tempDir: string): Promise<void> {
        try {
            if (await fs.pathExists(tempDir)) {
                await fs.remove(tempDir);
                console.log(`🧹 Cleaned up temporary directory: ${tempDir}`);
            }
        } catch (error) {
            console.error(`Failed to cleanup directory ${tempDir}:`, error);
        }
    }
}