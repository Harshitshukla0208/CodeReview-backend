import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { GitService } from '../services/gitService';
import { AnalysisService } from '../services/analysisService';
import { validateRepoUrl } from '../utils/validation';

const router = express.Router();

// Store analysis results in memory for MVP (use database in production)
const analysisStore = new Map<string, any>();

// POST /api/analyze - Submit repository for analysis
router.post('/', async (req, res) => {
    try {
        const { repositoryUrl } = req.body;

        // Validate input
        if (!repositoryUrl) {
            return res.status(400).json({
                error: 'Repository URL is required'
            });
        }

        if (!validateRepoUrl(repositoryUrl)) {
            return res.status(400).json({
                error: 'Invalid repository URL. Please provide a valid GitHub or GitLab URL.'
            });
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
router.get('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const analysis = analysisStore.get(id);

        if (!analysis) {
            return res.status(404).json({
                error: 'Analysis not found'
            });
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
    try {
        const gitService = new GitService();
        const analysisService = new AnalysisService();

        // Update progress: Cloning repository
        updateAnalysisProgress(analysisId, 10, 'Cloning repository...');

        const repoData = await gitService.cloneRepository(repositoryUrl);

        // Update progress: Discovering files
        updateAnalysisProgress(analysisId, 30, 'Discovering code files...');

        const codeFiles = await gitService.getCodeFiles(repoData.tempDir);

        // Update progress: Analyzing code
        updateAnalysisProgress(analysisId, 50, 'Analyzing code quality...');

        const analysisResults = await analysisService.analyzeRepository(codeFiles, repoData.repoName);

        // Update progress: Generating report
        updateAnalysisProgress(analysisId, 80, 'Generating report...');

        const finalReport = await analysisService.generateFinalReport(analysisResults, {
            repositoryUrl,
            repositoryName: repoData.repoName,
            totalFiles: codeFiles.length,
            linesOfCode: codeFiles.reduce((total, file) => total + file.content.split('\n').length, 0)
        });

        // Cleanup temporary directory
        await gitService.cleanup(repoData.tempDir);

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

    } catch (error: any) {
        console.error('Analysis processing error:', error);

        // Update with error status
        analysisStore.set(analysisId, {
            ...analysisStore.get(analysisId),
            status: 'failed',
            error: error.message,
            completedAt: new Date().toISOString()
        });
    }
}

function updateAnalysisProgress(analysisId: string, progress: number, message: string) {
    const analysis = analysisStore.get(analysisId);
    if (analysis) {
        analysisStore.set(analysisId, {
            ...analysis,
            progress,
            currentStep: message
        });
    }
}

export { router as analyzeRouter };