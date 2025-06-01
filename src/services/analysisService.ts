import OpenAI from 'openai';
import { CodeFile } from './gitService';
import { IssueAnalysis } from './issuesService';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export interface FileAnalysis {
    filePath: string;
    score: number;
    issues: Issue[];
    suggestions: string[];
    complexity: 'low' | 'medium' | 'high';
    maintainability: number;
}

export interface Issue {
    line?: number;
    type: 'security' | 'performance' | 'quality' | 'style' | 'bug';
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    suggestion: string;
}

export interface CategoryScore {
    score: number;
    issues: number;
    criticalIssues: number;
    suggestions: string[];
    details: string[];
}

export interface FinalReport {
    overview: {
        totalFiles: number;
        linesOfCode: number;
        overallScore: number;
        riskLevel: 'low' | 'medium' | 'high' | 'critical';
        repositoryName: string;
    };
    categories: {
        codeQuality: CategoryScore;
        security: CategoryScore;
        performance: CategoryScore;
        maintainability: CategoryScore;
    };
    fileAnalysis: FileAnalysis[];
    recommendations: {
        immediate: string[];
        shortTerm: string[];
        longTerm: string[];
    };
    summary: string;
}

export class AnalysisService {
    private readonly maxFilesPerBatch = 5;
    private readonly maxTokensPerFile = 4000;

    async analyzeRepository(codeFiles: CodeFile[], repoName: string): Promise<FileAnalysis[]> {
        console.log(`🔍 Starting analysis of ${codeFiles.length} files...`);

        const analyses: FileAnalysis[] = [];

        // Process files in batches to avoid rate limits
        for (let i = 0; i < codeFiles.length; i += this.maxFilesPerBatch) {
            const batch = codeFiles.slice(i, i + this.maxFilesPerBatch);
            console.log(`📊 Processing batch ${Math.floor(i / this.maxFilesPerBatch) + 1}/${Math.ceil(codeFiles.length / this.maxFilesPerBatch)}`);

            const batchAnalyses = await Promise.all(
                batch.map(file => this.analyzeFile(file))
            );

            analyses.push(...batchAnalyses);

            // Add small delay between batches to be respectful to API
            if (i + this.maxFilesPerBatch < codeFiles.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log(`✅ Analysis completed for ${analyses.length} files`);
        return analyses;
    }

    private async analyzeFile(file: CodeFile): Promise<FileAnalysis> {
        try {
            // Truncate very long files to fit within token limits
            const truncatedContent = this.truncateContent(file.content);

            const prompt = this.buildAnalysisPrompt(file.relativePath, truncatedContent, file.extension);

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini", // Using mini for cost efficiency in MVP
                messages: [
                    {
                        role: "system",
                        content: "You are an expert code reviewer. Analyze code thoroughly and provide structured feedback in the exact JSON format requested."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.1,
                max_tokens: 2000
            });

            const content = response.choices[0]?.message?.content;
            if (!content) {
                throw new Error('Empty response from OpenAI');
            }

            // Parse the JSON response
            const analysis = JSON.parse(content);

            return {
                filePath: file.relativePath,
                score: analysis.score || 70,
                issues: analysis.issues || [],
                suggestions: analysis.suggestions || [],
                complexity: analysis.complexity || 'medium',
                maintainability: analysis.maintainability || 70
            };

        } catch (error: any) {
            console.error(`Error analyzing file ${file.relativePath}:`, error.message);

            // Return a default analysis if AI analysis fails
            return {
                filePath: file.relativePath,
                score: 60,
                issues: [{
                    type: 'quality',
                    severity: 'medium',
                    message: 'Unable to analyze this file automatically',
                    suggestion: 'Manual review recommended'
                }],
                suggestions: ['Review this file manually for potential improvements'],
                complexity: 'medium',
                maintainability: 60
            };
        }
    }

    private buildAnalysisPrompt(filePath: string, content: string, extension: string): string {
        const fileType = this.getFileTypeDescription(extension);

        return `
Analyze this ${fileType} file and provide a comprehensive code review.

**File:** ${filePath}
**Content:**
\`\`\`${extension.slice(1)}
${content}
\`\`\`

Please analyze for:
1. **Code Quality**: Best practices, readability, maintainability
2. **Security**: Vulnerabilities, security anti-patterns
3. **Performance**: Efficiency, optimization opportunities
4. **Bugs**: Potential runtime errors, logic issues
5. **Style**: Consistent formatting, naming conventions

Respond with ONLY a valid JSON object in this exact format:
{
  "score": <number 0-100>,
  "complexity": "<low|medium|high>",
  "maintainability": <number 0-100>,
  "issues": [
    {
      "line": <number or null>,
      "type": "<security|performance|quality|style|bug>",
      "severity": "<low|medium|high|critical>",
      "message": "<brief description>",
      "suggestion": "<how to fix>"
    }
  ],
  "suggestions": [
    "<general improvement suggestion>",
    "<another suggestion>"
  ]
}

Focus on:
- Actionable feedback
- Specific line numbers when possible
- Clear explanations
- Prioritize critical security and bug issues
- Provide practical suggestions for improvement

Be thorough but concise. Identify real issues, not minor style preferences.
`;
    }

    private getFileTypeDescription(extension: string): string {
        const descriptions: Record<string, string> = {
            '.js': 'JavaScript',
            '.jsx': 'React JSX',
            '.ts': 'TypeScript',
            '.tsx': 'React TypeScript',
            '.py': 'Python',
            '.java': 'Java',
            '.cpp': 'C++',
            '.c': 'C',
            '.go': 'Go',
            '.rs': 'Rust',
            '.php': 'PHP',
            '.rb': 'Ruby',
            '.swift': 'Swift',
            '.kt': 'Kotlin',
            '.cs': 'C#',
            '.html': 'HTML',
            '.css': 'CSS',
            '.scss': 'SCSS',
            '.json': 'JSON configuration',
            '.yaml': 'YAML configuration',
            '.yml': 'YAML configuration'
        };

        return descriptions[extension] || 'code';
    }

    private truncateContent(content: string): string {
        const lines = content.split('\n');
        if (lines.length <= 200) {
            return content;
        }

        // Keep first 150 lines and last 50 lines for context
        const truncated = [
            ...lines.slice(0, 150),
            '\n// ... (content truncated for analysis) ...\n',
            ...lines.slice(-50)
        ].join('\n');

        return truncated;
    }

    async generateFinalReport(
fileAnalyses: FileAnalysis[], metadata: {
    repositoryUrl: string;
    repositoryName: string;
    totalFiles: number;
    linesOfCode: number;
}, githubIssuesAnalysis: { totalIssues: number; openIssues: number; closedIssues: number; categorySummary: { bugs: number; features: number; enhancements: number; documentation: number; questions: number; other: number; }; prioritySummary: { critical: number; high: number; medium: number; low: number; }; effortSummary: { high: number; medium: number; low: number; }; analyses: IssueAnalysis[]; insights: string[]; error?: undefined; } | { error: any; totalIssues: number; analyses: never[]; openIssues?: undefined; closedIssues?: undefined; categorySummary?: undefined; prioritySummary?: undefined; effortSummary?: undefined; insights?: undefined; } | null    ): Promise<FinalReport> {
        console.log('📋 Generating final report...');

        // Calculate category scores
        const categories = this.calculateCategoryScores(fileAnalyses);

        // Calculate overall score
        const overallScore = this.calculateOverallScore(categories);

        // Determine risk level
        const riskLevel = this.determineRiskLevel(overallScore, fileAnalyses);

        // Generate recommendations
        const recommendations = this.generateRecommendations(fileAnalyses, categories);

        // Generate executive summary
        const summary = this.generateSummary(overallScore, categories, metadata.repositoryName);

        return {
            overview: {
                totalFiles: metadata.totalFiles,
                linesOfCode: metadata.linesOfCode,
                overallScore,
                riskLevel,
                repositoryName: metadata.repositoryName
            },
            categories,
            fileAnalysis: fileAnalyses,
            recommendations,
            summary
        };
    }

    private calculateCategoryScores(analyses: FileAnalysis[]): FinalReport['categories'] {
        const categoryIssues = {
            security: analyses.flatMap(a => a.issues.filter(i => i.type === 'security')),
            performance: analyses.flatMap(a => a.issues.filter(i => i.type === 'performance')),
            quality: analyses.flatMap(a => a.issues.filter(i => i.type === 'quality' || i.type === 'bug')),
            style: analyses.flatMap(a => a.issues.filter(i => i.type === 'style'))
        };

        const calculateScore = (issues: Issue[]) => {
            if (issues.length === 0) return 85;

            const severityWeights = { low: 1, medium: 3, high: 7, critical: 15 };
            const totalWeight = issues.reduce((sum, issue) => sum + severityWeights[issue.severity], 0);
            const maxPossibleWeight = analyses.length * 5; // Assume max 5 critical issues per file

            return Math.max(0, Math.round(100 - (totalWeight / maxPossibleWeight) * 100));
        };

        return {
            codeQuality: {
                score: calculateScore(categoryIssues.quality),
                issues: categoryIssues.quality.length,
                criticalIssues: categoryIssues.quality.filter(i => i.severity === 'critical').length,
                suggestions: this.getTopSuggestions(categoryIssues.quality),
                details: categoryIssues.quality.slice(0, 5).map(i => i.message)
            },
            security: {
                score: calculateScore(categoryIssues.security),
                issues: categoryIssues.security.length,
                criticalIssues: categoryIssues.security.filter(i => i.severity === 'critical').length,
                suggestions: this.getTopSuggestions(categoryIssues.security),
                details: categoryIssues.security.slice(0, 5).map(i => i.message)
            },
            performance: {
                score: calculateScore(categoryIssues.performance),
                issues: categoryIssues.performance.length,
                criticalIssues: categoryIssues.performance.filter(i => i.severity === 'critical').length,
                suggestions: this.getTopSuggestions(categoryIssues.performance),
                details: categoryIssues.performance.slice(0, 5).map(i => i.message)
            },
            maintainability: {
                score: Math.round(analyses.reduce((sum, a) => sum + a.maintainability, 0) / analyses.length),
                issues: categoryIssues.style.length,
                criticalIssues: 0,
                suggestions: this.getTopSuggestions(categoryIssues.style),
                details: categoryIssues.style.slice(0, 5).map(i => i.message)
            }
        };
    }

    private getTopSuggestions(issues: Issue[]): string[] {
        const suggestionCounts = new Map<string, number>();

        issues.forEach(issue => {
            const current = suggestionCounts.get(issue.suggestion) || 0;
            suggestionCounts.set(issue.suggestion, current + 1);
        });

        return Array.from(suggestionCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([suggestion]) => suggestion);
    }

    private calculateOverallScore(categories: FinalReport['categories']): number {
        const weights = {
            security: 0.3,
            codeQuality: 0.25,
            performance: 0.25,
            maintainability: 0.2
        };

        return Math.round(
            categories.security.score * weights.security +
            categories.codeQuality.score * weights.codeQuality +
            categories.performance.score * weights.performance +
            categories.maintainability.score * weights.maintainability
        );
    }

    private determineRiskLevel(score: number, analyses: FileAnalysis[]): 'low' | 'medium' | 'high' | 'critical' {
        const criticalIssues = analyses.flatMap(a => a.issues).filter(i => i.severity === 'critical').length;

        if (criticalIssues > 0 || score < 40) return 'critical';
        if (score < 60) return 'high';
        if (score < 80) return 'medium';
        return 'low';
    }

    private generateRecommendations(analyses: FileAnalysis[], categories: FinalReport['categories']): FinalReport['recommendations'] {
        const allIssues = analyses.flatMap(a => a.issues);
        const criticalIssues = allIssues.filter(i => i.severity === 'critical');
        const highIssues = allIssues.filter(i => i.severity === 'high');

        return {
            immediate: [
                ...criticalIssues.slice(0, 3).map(i => i.suggestion),
                ...highIssues.slice(0, 2).map(i => i.suggestion)
            ].filter(Boolean),
            shortTerm: [
                'Implement automated testing if not present',
                'Set up continuous integration pipeline',
                'Add comprehensive error handling',
                'Improve code documentation',
                'Establish coding standards and linting rules'
            ],
            longTerm: [
                'Consider architectural improvements for scalability',
                'Implement monitoring and logging',
                'Regular security audits',
                'Performance optimization based on usage patterns',
                'Team code review processes'
            ]
        };
    }

    private generateSummary(score: number, categories: FinalReport['categories'], repoName: string): string {
        const riskDescriptions = {
            low: 'well-maintained with minimal issues',
            medium: 'generally good but has some areas for improvement',
            high: 'has several important issues that should be addressed',
            critical: 'has critical issues that require immediate attention'
        };

        const riskLevel = this.determineRiskLevel(score, []);

        return `The ${repoName} repository scores ${score}/100 and is ${riskDescriptions[riskLevel]}. 
Security score: ${categories.security.score}/100 (${categories.security.criticalIssues} critical issues). 
Code quality: ${categories.codeQuality.score}/100. 
Performance: ${categories.performance.score}/100. 
Focus on ${categories.security.criticalIssues > 0 ? 'security vulnerabilities' : 'code quality improvements'} as the next priority.`;
    }
}