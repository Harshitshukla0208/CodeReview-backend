export function validateRepoUrl(url: string): boolean {
    if (!url || typeof url !== 'string') {
        return false;
    }

    // GitHub patterns
    const githubPatterns = [
        /^https:\/\/github\.com\/[\w\-\.]+\/[\w\-\.]+\/?$/,
        /^https:\/\/github\.com\/[\w\-\.]+\/[\w\-\.]+\.git$/
    ];

    // GitLab patterns
    const gitlabPatterns = [
        /^https:\/\/gitlab\.com\/[\w\-\.]+\/[\w\-\.]+\/?$/,
        /^https:\/\/gitlab\.com\/[\w\-\.]+\/[\w\-\.]+\.git$/
    ];

    // Check against all patterns
    const allPatterns = [...githubPatterns, ...gitlabPatterns];
    return allPatterns.some(pattern => pattern.test(url.trim()));
}

export function sanitizeRepoUrl(url: string): string {
    if (!url) return '';

    // Remove trailing slash and .git extension for consistency
    return url.trim().replace(/\.git$/, '').replace(/\/$/, '');
}