import express, { Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { GitService } from '../services/gitService';
import { AnalysisService } from '../services/analysisService';
import { GitHubIssuesService } from '../services/issuesService';
import { validateRepoUrl } from '../utils/validation';

const router: Router = express.Router();

// Store analysis results in memory for MVP (use database in production)
const analysisStore = new Map<string, any>();
// Track running processes to clean them up if needed
const runningProcesses = new Set<string>();

// POST /api/analyze - Submit repository for analysis
router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const { repositoryUrl, includeGitHubIssues = true, githubToken } = req.body;

        // Validate input
        if (!repositoryUrl) {
            res.status(400).json({
                error: 'Repository URL is required'
            });
            return;
        }

        if (!validateRepoUrl(repositoryUrl)) {
            res.status(400).json({
                error: 'Invalid repository URL. Please provide a valid GitHub or GitLab URL.'
            });
            return;
        }

        // Validate GitHub URL if issues analysis is requested
        if (includeGitHubIssues && !repositoryUrl.includes('github.com')) {
            res.status(400).json({
                error: 'GitHub issues analysis is only available for GitHub repositories'
            });
            return;
        }

        const analysisId = uuidv4();

        // Store initial analysis record
        analysisStore.set(analysisId, {
            id: analysisId,
            repositoryUrl,
            includeGitHubIssues,
            status: 'processing',
            createdAt: new Date().toISOString(),
            progress: 0
        });

        // Start analysis in background
        processAnalysis(analysisId, repositoryUrl, includeGitHubIssues, githubToken);

        res.json({
            analysisId,
            status: 'processing',
            message: 'Analysis started. Check back for results.',
            estimatedTime: includeGitHubIssues ? '3-7 minutes' : '2-5 minutes'
        });

    } catch (error: any) {
        console.error('Analysis submission error:', error);
        res.status(500).json({
            error: 'Failed to start analysis',
            message: error.message
        });
    }
});

// GET /api/analyze/:id - Get analysis results
router.get('/:id', (req: Request, res: Response): void => {
    try {
        const { id } = req.params;
        const analysis = analysisStore.get(id);

        if (!analysis) {
            res.status(404).json({
                error: 'Analysis not found'
            });
            return;
        }

        res.json(analysis);
    } catch (error: any) {
        console.error('Get analysis error:', error);
        res.status(500).json({
            error: 'Failed to retrieve analysis',
            message: error.message
        });
    }
});

// GET /api/analyze/:id/issues - Get detailed GitHub issues analysis
router.get('/:id/issues', (req: Request, res: Response): void => {
    try {
        const { id } = req.params;
        const analysis = analysisStore.get(id);

        if (!analysis) {
            res.status(404).json({
                error: 'Analysis not found'
            });
            return;
        }

        if (!analysis.results?.githubIssues) {
            res.status(404).json({
                error: 'GitHub issues analysis not available for this repository'
            });
            return;
        }

        res.json({
            analysisId: id,
            repositoryName: analysis.repositoryName,
            githubIssues: analysis.results.githubIssues
        });
    } catch (error: any) {
        console.error('Get issues analysis error:', error);
        res.status(500).json({
            error: 'Failed to retrieve issues analysis',
            message: error.message
        });
    }
});

// GET /api/analyze/:id/issues/:issueNumber - Get specific issue analysis
router.get('/:id/issues/:issueNumber', (req: Request, res: Response): void => {
    try {
        const { id, issueNumber } = req.params;
        const analysis = analysisStore.get(id);

        if (!analysis) {
            res.status(404).json({
                error: 'Analysis not found'
            });
            return;
        }

        if (!analysis.results?.githubIssues?.analyses) {
            res.status(404).json({
                error: 'GitHub issues analysis not available for this repository'
            });
            return;
        }

        const issueAnalysis = analysis.results.githubIssues.analyses.find(
            (ia: any) => ia.issue.number === parseInt(issueNumber)
        );

        if (!issueAnalysis) {
            res.status(404).json({
                error: `Issue #${issueNumber} not found in analysis`
            });
            return;
        }

        res.json({
            analysisId: id,
            repositoryName: analysis.repositoryName,
            issueAnalysis
        });
    } catch (error: any) {
        console.error('Get specific issue analysis error:', error);
        res.status(500).json({
            error: 'Failed to retrieve issue analysis',
            message: error.message
        });
    }
});

// Background analysis processing
async function processAnalysis(
    analysisId: string,
    repositoryUrl: string,
    includeGitHubIssues: boolean = true,
    githubToken?: string
) {
    let gitService: GitService | null = null;
    let repoData: any = null;

    try {
        // Mark process as running
        runningProcesses.add(analysisId);

        gitService = new GitService();
        const analysisService = new AnalysisService();

        // Update progress: Cloning repository
        updateAnalysisProgress(analysisId, 10, 'Cloning repository...');

        repoData = await gitService.cloneRepository(repositoryUrl);

        // Check if process was cancelled
        if (!runningProcesses.has(analysisId)) {
            throw new Error('Analysis was cancelled');
        }

        // Update progress: Discovering files
        updateAnalysisProgress(analysisId, 20, 'Discovering code files...');

        const codeFiles = await gitService.getCodeFiles(repoData.tempDir);

        // Check if process was cancelled
        if (!runningProcesses.has(analysisId)) {
            throw new Error('Analysis was cancelled');
        }

        // Update progress: Analyzing code
        updateAnalysisProgress(analysisId, 40, 'Analyzing code quality...');

        const analysisResults = await analysisService.analyzeRepository(codeFiles, repoData.repoName);

        // Check if process was cancelled
        if (!runningProcesses.has(analysisId)) {
            throw new Error('Analysis was cancelled');
        }

        // Analyze GitHub issues if requested
        let githubIssuesAnalysis = null;
        if (includeGitHubIssues) {
            try {
                updateAnalysisProgress(analysisId, 60, 'Fetching GitHub issues...');

                const githubService = new GitHubIssuesService(githubToken);
                const issues = await githubService.fetchRepositoryIssues(repositoryUrl);

                // Check if process was cancelled
                if (!runningProcesses.has(analysisId)) {
                    throw new Error('Analysis was cancelled');
                }

                updateAnalysisProgress(analysisId, 70, 'Analyzing GitHub issues...');

                const issueAnalyses = await githubService.analyzeIssues(issues, codeFiles);

                githubIssuesAnalysis = {
                    totalIssues: issues.length,
                    openIssues: issues.filter((i: { state: string; }) => i.state === 'open').length,
                    closedIssues: issues.filter((i: { state: string; }) => i.state === 'closed').length,
                    categorySummary: {
                        bugs: issueAnalyses.filter((ia: { category: string; }) => ia.category === 'bug').length,
                        features: issueAnalyses.filter((ia: { category: string; }) => ia.category === 'feature').length,
                        enhancements: issueAnalyses.filter((ia: { category: string; }) => ia.category === 'enhancement').length,
                        documentation: issueAnalyses.filter((ia: { category: string; }) => ia.category === 'documentation').length,
                        questions: issueAnalyses.filter((ia: { category: string; }) => ia.category === 'question').length,
                        other: issueAnalyses.filter((ia: { category: string; }) => ia.category === 'other').length
                    },
                    prioritySummary: {
                        critical: issueAnalyses.filter((ia: { priority: string; }) => ia.priority === 'critical').length,
                        high: issueAnalyses.filter((ia: { priority: string; }) => ia.priority === 'high').length,
                        medium: issueAnalyses.filter((ia: { priority: string; }) => ia.priority === 'medium').length,
                        low: issueAnalyses.filter((ia: { priority: string; }) => ia.priority === 'low').length
                    },
                    effortSummary: {
                        high: issueAnalyses.filter((ia: { estimatedEffort: string; }) => ia.estimatedEffort === 'high').length,
                        medium: issueAnalyses.filter((ia: { estimatedEffort: string; }) => ia.estimatedEffort === 'medium').length,
                        low: issueAnalyses.filter((ia: { estimatedEffort: string; }) => ia.estimatedEffort === 'low').length
                    },
                    analyses: issueAnalyses,
                    insights: generateIssuesInsights(issueAnalyses)
                };

                console.log(`✅ GitHub issues analysis completed: ${issues.length} issues processed`);
                console.log(JSON.stringify(githubIssuesAnalysis, null, 2));
            } catch (error: any) {
                console.warn('GitHub issues analysis failed:', error.message);
                githubIssuesAnalysis = {
                    error: error.message,
                    totalIssues: 0,
                    analyses: []
                };
            }
        }

        // Check if process was cancelled
        if (!runningProcesses.has(analysisId)) {
            throw new Error('Analysis was cancelled');
        }

        // Update progress: Generating report
        updateAnalysisProgress(analysisId, 85, 'Generating comprehensive report...');

        const finalReport = await analysisService.generateFinalReport(
            analysisResults,
            {
                repositoryUrl,
                repositoryName: repoData.repoName,
                totalFiles: codeFiles.length,
                linesOfCode: codeFiles.reduce((total, file) => total + file.content.split('\n').length, 0)
            },
            githubIssuesAnalysis
        );

        // Update final results
        analysisStore.set(analysisId, {
            id: analysisId,
            repositoryUrl,
            repositoryName: repoData.repoName,
            includeGitHubIssues,
            status: 'completed',
            progress: 100,
            createdAt: analysisStore.get(analysisId)?.createdAt,
            completedAt: new Date().toISOString(),
            results: finalReport
        });

        console.log(`✅ Analysis completed successfully for ${repoData.repoName}`);

    } catch (error: any) {
        console.error('Analysis processing error:', error);

        // Update with error status
        const existingAnalysis = analysisStore.get(analysisId);
        if (existingAnalysis) {
            analysisStore.set(analysisId, {
                ...existingAnalysis,
                status: 'failed',
                error: error.message,
                completedAt: new Date().toISOString()
            });
        }
    } finally {
        // Always cleanup resources
        if (gitService && repoData) {
            try {
                await gitService.cleanup(repoData.tempDir);
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError);
            }
        }

        // Remove from running processes
        runningProcesses.delete(analysisId);
    }
}

function updateAnalysisProgress(analysisId: string, progress: number, message: string) {
    const analysis = analysisStore.get(analysisId);
    if (analysis && runningProcesses.has(analysisId)) {
        analysisStore.set(analysisId, {
            ...analysis,
            progress,
            currentStep: message
        });
    }
}

function generateIssuesInsights(analyses: any[]): string[] {
    const insights: string[] = [];

    if (analyses.length === 0) {
        return ['No issues found for analysis'];
    }

    // Priority insights
    const criticalIssues = analyses.filter(a => a.priority === 'critical').length;
    const highPriorityIssues = analyses.filter(a => a.priority === 'high').length;

    if (criticalIssues > 0) {
        insights.push(`🚨 ${criticalIssues} critical issue${criticalIssues > 1 ? 's' : ''} require immediate attention`);
    }

    if (highPriorityIssues > 0) {
        insights.push(`⚠️ ${highPriorityIssues} high-priority issue${highPriorityIssues > 1 ? 's' : ''} should be addressed soon`);
    }

    // Category insights
    const bugCount = analyses.filter(a => a.category === 'bug').length;
    const featureCount = analyses.filter(a => a.category === 'feature').length;

    if (bugCount > featureCount * 2) {
        insights.push('🐛 High bug-to-feature ratio suggests focus on stability over new features');
    }

    // Effort insights
    const highEffortIssues = analyses.filter(a => a.estimatedEffort === 'high').length;
    const totalIssues = analyses.length;

    if (highEffortIssues / totalIssues > 0.3) {
        insights.push('💪 Many issues require significant effort - consider breaking them into smaller tasks');
    }

    // File correlation insights
    const filesMentioned = new Set();
    analyses.forEach(a => {
        a.relatedFiles.forEach((file: string) => filesMentioned.add(file));
    });

    if (filesMentioned.size > 0) {
        insights.push(`📁 Issues reference ${filesMentioned.size} different file${filesMentioned.size > 1 ? 's' : ''} across the codebase`);
    }

    return insights.length > 0 ? insights : ['Analysis completed successfully'];
}

// Cleanup function for graceful shutdown
export function cleanupRunningAnalyses() {
    console.log('🧹 Cleaning up running analyses...');
    runningProcesses.clear();
}

// Handle process termination
process.on('SIGINT', () => {
    cleanupRunningAnalyses();
    process.exit(0);
});

process.on('SIGTERM', () => {
    cleanupRunningAnalyses();
    process.exit(0);
});

export { router as analyzeRouter };