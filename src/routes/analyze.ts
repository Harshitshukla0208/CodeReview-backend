import express, { Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { GitService } from '../services/gitService';
import { AnalysisService } from '../services/analysisService';
import { validateRepoUrl } from '../utils/validation';

const router: Router = express.Router();

// Store analysis results in memory for MVP (use database in production)
const analysisStore = new Map<string, any>();
// Track running processes to clean them up if needed
const runningProcesses = new Set<string>();

// POST /api/analyze - Submit repository for analysis
router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const { repositoryUrl } = req.body;

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

        const analysisId = uuidv4();

        // Store initial analysis record
        analysisStore.set(analysisId, {
            id: analysisId,
            repositoryUrl,
            status: 'processing',
            createdAt: new Date().toISOString(),
            progress: 0
        });

        // Start analysis in background
        processAnalysis(analysisId, repositoryUrl);

        res.json({
            analysisId,
            status: 'processing',
            message: 'Analysis started. Check back for results.',
            estimatedTime: '2-5 minutes'
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

// Background analysis processing
async function processAnalysis(analysisId: string, repositoryUrl: string) {
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
        updateAnalysisProgress(analysisId, 30, 'Discovering code files...');

        const codeFiles = await gitService.getCodeFiles(repoData.tempDir);

        // Check if process was cancelled
        if (!runningProcesses.has(analysisId)) {
            throw new Error('Analysis was cancelled');
        }

        // Update progress: Analyzing code
        updateAnalysisProgress(analysisId, 50, 'Analyzing code quality...');

        const analysisResults = await analysisService.analyzeRepository(codeFiles, repoData.repoName);

        // Check if process was cancelled
        if (!runningProcesses.has(analysisId)) {
            throw new Error('Analysis was cancelled');
        }

        // Update progress: Generating report
        updateAnalysisProgress(analysisId, 80, 'Generating report...');

        const finalReport = await analysisService.generateFinalReport(analysisResults, {
            repositoryUrl,
            repositoryName: repoData.repoName,
            totalFiles: codeFiles.length,
            linesOfCode: codeFiles.reduce((total, file) => total + file.content.split('\n').length, 0)
        });

        // Update final results
        analysisStore.set(analysisId, {
            id: analysisId,
            repositoryUrl,
            repositoryName: repoData.repoName,
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