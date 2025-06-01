import { Octokit } from '@octokit/rest';
import { CodeFile } from './gitService';

export interface GitHubIssue {
    id: number;
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    labels: string[];
    createdAt: string;
    updatedAt: string;
    author: string;
    url: string;
    comments: GitHubComment[];
}

export interface GitHubComment {
    id: number;
    body: string;
    author: string;
    createdAt: string;
}

export interface IssueAnalysis {
    issue: GitHubIssue;
    category: 'bug' | 'feature' | 'enhancement' | 'documentation' | 'question' | 'other';
    priority: 'low' | 'medium' | 'high' | 'critical';
    relatedFiles: string[];
    suggestions: IssueSuggestion[];
    estimatedEffort: 'low' | 'medium' | 'high';
    codeContext: CodeContext[];
}

export interface IssueSuggestion {
    type: 'code_change' | 'new_file' | 'documentation' | 'testing' | 'refactor';
    description: string;
    filePath?: string;
    lineNumber?: number;
    codeSnippet?: string;
    suggestedChange?: string;
    reasoning: string;
}

export interface CodeContext {
    filePath: string;
    lineNumber: number;
    contextLines: string[];
    relevanceScore: number;
}

export class GitHubIssuesService {
    private octokit: Octokit;
    private readonly maxIssuesPerRepo = 50; // Limit to avoid rate limits
    private readonly maxCommentsPerIssue = 10;

    constructor(githubToken?: string) {
        this.octokit = new Octokit({
            auth: githubToken || process.env.GITHUB_TOKEN,
        });
    }

    async fetchRepositoryIssues(repositoryUrl: string): Promise<GitHubIssue[]> {
        try {
            const { owner, repo } = this.parseGitHubUrl(repositoryUrl);
            
            console.log(`🔍 Fetching issues for ${owner}/${repo}...`);

            // Fetch issues (both open and closed for comprehensive analysis)
            const issuesResponse = await this.octokit.rest.issues.listForRepo({
                owner,
                repo,
                state: 'all',
                per_page: this.maxIssuesPerRepo,
                sort: 'updated',
                direction: 'desc'
            });

            const issues: GitHubIssue[] = [];

            for (const issue of issuesResponse.data) {
                // Skip pull requests (GitHub API returns both issues and PRs)
                if (issue.pull_request) continue;

                // Fetch comments for each issue
                let comments: GitHubComment[] = [];
                try {
                    const commentsResponse = await this.octokit.rest.issues.listComments({
                        owner,
                        repo,
                        issue_number: issue.number,
                        per_page: this.maxCommentsPerIssue
                    });

                    comments = commentsResponse.data.map((comment) => ({
                        id: comment.id,
                        body: comment.body || '',
                        author: comment.user?.login || 'unknown',
                        createdAt: comment.created_at
                    }));
                } catch (error) {
                    console.warn(`Failed to fetch comments for issue #${issue.number}`);
                }

                issues.push({
                    id: issue.id,
                    number: issue.number,
                    title: issue.title,
                    body: issue.body || '',
                    state: issue.state as 'open' | 'closed',
                    labels: issue.labels.map((label) => {
                        if (typeof label === 'string') {
                            return label;
                        }
                        return label.name || '';
                    }),
                    createdAt: issue.created_at,
                    updatedAt: issue.updated_at,
                    author: issue.user?.login || 'unknown',
                    url: issue.html_url,
                    comments
                });

                // Add small delay to respect rate limits
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            console.log(`✅ Fetched ${issues.length} issues`);
            return issues;

        } catch (error: any) {
            if (error.status === 404) {
                throw new Error('Repository not found or not accessible. Make sure the repository exists and is public.');
            }
            if (error.status === 403) {
                throw new Error('GitHub API rate limit exceeded or insufficient permissions. Please provide a GitHub token.');
            }
            throw new Error(`Failed to fetch repository issues: ${error.message}`);
        }
    }

    async analyzeIssues(issues: GitHubIssue[], codeFiles: CodeFile[]): Promise<IssueAnalysis[]> {
        console.log(`🔍 Analyzing ${issues.length} issues against codebase...`);

        const analyses: IssueAnalysis[] = [];

        // Process issues in batches to avoid overwhelming the AI API
        const batchSize = 3;
        for (let i = 0; i < issues.length; i += batchSize) {
            const batch = issues.slice(i, i + batchSize);
            console.log(`📊 Processing issue batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(issues.length / batchSize)}`);

            const batchAnalyses = await Promise.all(
                batch.map(issue => this.analyzeIssue(issue, codeFiles))
            );

            analyses.push(...batchAnalyses);

            // Add delay between batches
            if (i + batchSize < issues.length) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Sort by priority and creation date
        analyses.sort((a, b) => {
            const priorityWeight = { critical: 4, high: 3, medium: 2, low: 1 };
            const aPriority = priorityWeight[a.priority];
            const bPriority = priorityWeight[b.priority];
            
            if (aPriority !== bPriority) {
                return bPriority - aPriority;
            }
            
            return new Date(b.issue.createdAt).getTime() - new Date(a.issue.createdAt).getTime();
        });

        console.log(`✅ Issue analysis completed`);
        return analyses;
    }

    private async analyzeIssue(issue: GitHubIssue, codeFiles: CodeFile[]): Promise<IssueAnalysis> {
        try {
            // Find potentially related files based on issue content
            const relatedFiles = this.findRelatedFiles(issue, codeFiles);
            
            // Get code context for related files
            const codeContext = this.extractCodeContext(issue, relatedFiles);

            // Use AI to analyze the issue and generate suggestions
            const aiAnalysis = await this.getAIIssueAnalysis(issue, codeContext);

            return {
                issue,
                category: this.categorizeIssue(issue),
                priority: this.prioritizeIssue(issue),
                relatedFiles: relatedFiles.map(f => f.relativePath),
                suggestions: aiAnalysis.suggestions,
                estimatedEffort: aiAnalysis.estimatedEffort,
                codeContext
            };

        } catch (error) {
            console.error(`Error analyzing issue #${issue.number}:`, error);
            
            // Return basic analysis if AI fails
            return {
                issue,
                category: this.categorizeIssue(issue),
                priority: this.prioritizeIssue(issue),
                relatedFiles: [],
                suggestions: [{
                    type: 'documentation',
                    description: 'Manual investigation required for this issue',
                    reasoning: 'Automated analysis failed - requires human review'
                }],
                estimatedEffort: 'medium',
                codeContext: []
            };
        }
    }

    private findRelatedFiles(issue: GitHubIssue, codeFiles: CodeFile[]): CodeFile[] {
        const searchTerms = this.extractSearchTerms(issue);
        const relatedFiles: Array<{ file: CodeFile; score: number }> = [];

        for (const file of codeFiles) {
            let score = 0;

            // Search in file path
            for (const term of searchTerms) {
                if (file.relativePath.toLowerCase().includes(term.toLowerCase())) {
                    score += 10;
                }
            }

            // Search in file content
            const content = file.content.toLowerCase();
            for (const term of searchTerms) {
                const regex = new RegExp(`\\b${term.toLowerCase()}\\b`, 'g');
                const matches = content.match(regex);
                if (matches) {
                    score += matches.length * 2;
                }
            }

            // Bonus for certain file types mentioned in issue
            if (issue.body.toLowerCase().includes(file.extension)) {
                score += 5;
            }

            if (score > 0) {
                relatedFiles.push({ file, score });
            }
        }

        // Return top 10 most relevant files
        return relatedFiles
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map(rf => rf.file);
    }

    private extractSearchTerms(issue: GitHubIssue): string[] {
        const text = `${issue.title} ${issue.body}`.toLowerCase();
        
        // Extract potential function names, class names, file names
        const terms = new Set<string>();
        
        // Extract words that look like code identifiers
        const codePattern = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        const matches = text.match(codePattern) || [];
        
        for (const match of matches) {
            if (match.length > 2 && match.length < 50) {
                terms.add(match);
            }
        }

        // Extract file paths mentioned
        const filePattern = /[\w\/\.-]+\.(js|jsx|ts|tsx|py|java|cpp|go|rs|php|rb|swift|kt|cs|html|css|json|yaml|yml)/g;
        const fileMatches = text.match(filePattern) || [];
        fileMatches.forEach(match => terms.add(match));

        // Extract quoted strings (might be error messages or function names)
        const quotedPattern = /["`']([^"`']+)["`']/g;
        let quotedMatch;
        while ((quotedMatch = quotedPattern.exec(text)) !== null) {
            if (quotedMatch[1].length > 2 && quotedMatch[1].length < 100) {
                terms.add(quotedMatch[1]);
            }
        }

        return Array.from(terms).slice(0, 20); // Limit to prevent too many terms
    }

    private extractCodeContext(issue: GitHubIssue, relatedFiles: CodeFile[]): CodeContext[] {
        const contexts: CodeContext[] = [];
        const searchTerms = this.extractSearchTerms(issue);

        for (const file of relatedFiles.slice(0, 5)) { // Limit to top 5 files
            const lines = file.content.split('\n');
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                let relevanceScore = 0;

                // Check if line contains search terms
                for (const term of searchTerms) {
                    if (line.toLowerCase().includes(term.toLowerCase())) {
                        relevanceScore += 2;
                    }
                }

                // Bonus for lines with common issue indicators
                if (line.includes('TODO') || line.includes('FIXME') || line.includes('BUG')) {
                    relevanceScore += 3;
                }

                if (relevanceScore > 0) {
                    // Get context lines around the relevant line
                    const start = Math.max(0, i - 2);
                    const end = Math.min(lines.length - 1, i + 2);
                    const contextLines = lines.slice(start, end + 1);

                    contexts.push({
                        filePath: file.relativePath,
                        lineNumber: i + 1,
                        contextLines,
                        relevanceScore
                    });
                }
            }
        }

        // Return top contexts sorted by relevance
        return contexts
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, 10);
    }

    private async getAIIssueAnalysis(issue: GitHubIssue, codeContext: CodeContext[]): Promise<{
        suggestions: IssueSuggestion[];
        estimatedEffort: 'low' | 'medium' | 'high';
    }> {
        // This would integrate with your existing OpenAI service
        // For now, return a basic structure - you can implement the AI call similar to your analysisService
        
        const suggestions: IssueSuggestion[] = [];
        
        // Basic heuristic-based suggestions
        if (issue.body.toLowerCase().includes('error') || issue.body.toLowerCase().includes('exception')) {
            suggestions.push({
                type: 'code_change',
                description: 'Add proper error handling and validation',
                reasoning: 'Issue mentions errors which suggests missing error handling'
            });
        }

        if (issue.body.toLowerCase().includes('performance') || issue.body.toLowerCase().includes('slow')) {
            suggestions.push({
                type: 'refactor',
                description: 'Optimize performance-critical code sections',
                reasoning: 'Issue mentions performance concerns'
            });
        }

        if (issue.body.toLowerCase().includes('test') || issue.body.toLowerCase().includes('testing')) {
            suggestions.push({
                type: 'testing',
                description: 'Add comprehensive test coverage for affected functionality',
                reasoning: 'Issue relates to testing requirements'
            });
        }

        // Add context-specific suggestions
        for (const context of codeContext.slice(0, 3)) {
            suggestions.push({
                type: 'code_change',
                description: `Review and potentially modify code in ${context.filePath}`,
                filePath: context.filePath,
                lineNumber: context.lineNumber,
                codeSnippet: context.contextLines.join('\n'),
                reasoning: `This code section appears related to the issue based on content analysis`
            });
        }

        const estimatedEffort: 'low' | 'medium' | 'high' = 
            issue.labels.some(label => label.toLowerCase().includes('major') || label.toLowerCase().includes('breaking')) ? 'high' :
            issue.labels.some(label => label.toLowerCase().includes('minor') || label.toLowerCase().includes('easy')) ? 'low' :
            'medium';

        return { suggestions, estimatedEffort };
    }

    private categorizeIssue(issue: GitHubIssue): 'bug' | 'feature' | 'enhancement' | 'documentation' | 'question' | 'other' {
        const title = issue.title.toLowerCase();
        const labels = issue.labels.map(l => l.toLowerCase());
        const body = issue.body.toLowerCase();

        if (labels.some(l => l.includes('bug')) || title.includes('bug') || title.includes('error') || title.includes('fix')) {
            return 'bug';
        }
        if (labels.some(l => l.includes('feature')) || title.includes('feature') || title.includes('implement')) {
            return 'feature';
        }
        if (labels.some(l => l.includes('enhancement')) || title.includes('improve') || title.includes('enhance')) {
            return 'enhancement';
        }
        if (labels.some(l => l.includes('documentation')) || title.includes('docs') || title.includes('documentation')) {
            return 'documentation';
        }
        if (labels.some(l => l.includes('question')) || title.includes('question') || title.includes('how to')) {
            return 'question';
        }
        
        return 'other';
    }

    private prioritizeIssue(issue: GitHubIssue): 'low' | 'medium' | 'high' | 'critical' {
        const labels = issue.labels.map(l => l.toLowerCase());
        const title = issue.title.toLowerCase();

        // Critical indicators
        if (labels.some(l => l.includes('critical') || l.includes('urgent') || l.includes('security')) ||
            title.includes('critical') || title.includes('urgent') || title.includes('security') ||
            title.includes('crash') || title.includes('data loss')) {
            return 'critical';
        }

        // High priority indicators
        if (labels.some(l => l.includes('high') || l.includes('important') || l.includes('priority')) ||
            title.includes('blocker') || title.includes('regression') || title.includes('production')) {
            return 'high';
        }

        // Low priority indicators
        if (labels.some(l => l.includes('low') || l.includes('minor') || l.includes('nice-to-have')) ||
            title.includes('minor') || title.includes('cosmetic') || issue.state === 'closed') {
            return 'low';
        }

        return 'medium';
    }

    private parseGitHubUrl(url: string): { owner: string; repo: string } {
        const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) {
            throw new Error('Invalid GitHub URL format');
        }

        let repo = match[2];
        if (repo.endsWith('.git')) {
            repo = repo.slice(0, -4);
        }

        return {
            owner: match[1],
            repo
        };
    }
}