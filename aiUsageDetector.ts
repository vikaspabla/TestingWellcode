import { prisma } from '@/utils/prisma';
import { Octokit } from '@octokit/rest';
import { getRepositoryFromWebhook, getRepositoryConfig } from '@/utils/repoConfig';

/**
 * Patterns that may indicate AI-generated code
 */
const AI_PATTERNS = [
  // Comment patterns
  /\/\/ Generated (by|with) (ChatGPT|GPT|AI|Copilot)/i,
  /\/\* This (code|file|function) was (generated|created|written) (by|with) AI/i,
  
  // Code style patterns
  /\/\/ TODO: (Implement|Add|Fix|Update)/i, // Common in AI-generated code
  
  // Specific AI-generated code markers
  /\/\/ Note: This is a simplified implementation/i,
  /\/\/ This is a basic implementation/i
];

/**
 * Detect potential AI usage in PR content
 */
export async function detectAIUsage(pr: any): Promise<{
  score: number;
  confidence: number;
  patterns: string[];
}> {
  try {
    // Extract repository information first, before creating the GitHub client
    let owner, repo;
    
    // Use the repository from PR if available, otherwise fall back to config
    
    // First check for repository info in the main webhook payload (highest priority)
    if (pr.repository && typeof pr.repository === 'object') {
      // Debug log the repository object structure
      console.log(`[AI] Repository object structure in aiUsageDetector:`, JSON.stringify(pr.repository, null, 2).substring(0, 500) + '...');
      
      // Extract owner from repository structure
      // The repository might be from database with different structure
      let extractedOwner = '';
      
      // Handle GitHub API repository objects
      if (pr.repository.owner && typeof pr.repository.owner === 'object') {
        extractedOwner = pr.repository.owner.login || '';
        console.log(`[AI] Extracted owner from repository.owner object: ${extractedOwner}`);
      } 
      // Handle database repository objects with account property
      else if (pr.repository.account && typeof pr.repository.account === 'object') {
        extractedOwner = pr.repository.account.name || '';
        console.log(`[AI] Extracted owner from repository.account object: ${extractedOwner}`);
      }
      // Try extracting from full_name
      else if (pr.repository.full_name || pr.repository.fullName) {
        const fullName = pr.repository.full_name || pr.repository.fullName || '';
        const parts = fullName.split('/');
        if (parts.length === 2) {
          extractedOwner = parts[0];
          console.log(`[AI] Extracted owner from fullName: ${extractedOwner}`);
        }
      }
      
      // Set owner if we found it
      if (extractedOwner) {
        owner = extractedOwner;
      }
      
      // Extract repo name directly
      repo = pr.repository.name || '';
      console.log(`[AI] Extracted repo name: ${repo}`);
      
      // Use full_name if available, otherwise build it from owner/repo
      let repoFullName = '';
      if (pr.repository.full_name || pr.repository.fullName) {
        repoFullName = pr.repository.full_name || pr.repository.fullName || '';
        console.log(`[AI] Using repository.full_name: ${repoFullName}`);
        
        // Override owner/repo from full_name if needed
        if (!owner || !repo) {
          const parts = repoFullName.split('/');
          if (parts.length === 2) {
            owner = parts[0];
            repo = parts[1];
            console.log(`[AI] Extracted owner/repo from full_name: ${owner}/${repo}`);
          }
        }
      } else {
        repoFullName = owner && repo ? `${owner}/${repo}` : '';
        console.log(`[AI] Built full_name from owner/repo: ${repoFullName}`);
      }
      
      if (owner && repo) {
        console.log(`[AI][VALIDATION] Repository extraction successful: ${owner}/${repo} from ${pr.repository.account ? 'database format' : 'GitHub API format'}`);
      } else {
        console.warn(`[AI] Incomplete repository info in webhook payload: owner=${owner}, repo=${repo}`);
      }
    }
    // Try using repository fullName property
    else if (pr.repository && (pr.repository.fullName || pr.repository.full_name)) {
      const repoFullName = pr.repository.fullName || pr.repository.full_name;
      [owner, repo] = repoFullName.split('/');
      console.log(`[AI] Using repository from PR: ${repoFullName}`);
    } else if (pr.repository) {
      // Try to extract repository info from the PR object
      const webhookRepo = getRepositoryFromWebhook({ repository: pr.repository });
      if (webhookRepo) {
        owner = webhookRepo.owner;
        repo = webhookRepo.name;
        console.log(`[AI] Extracted repository from PR object: ${webhookRepo.fullName}`);
      } else {
        // Log error - we need repository information
        console.error('[AI] Could not determine repository information from PR object');
        return {
          score: 0,
          confidence: 0,
          patterns: ['Repository information missing']
        };
      }
    } else {
      // Try to extract repository from PR URL if available
      if (pr.html_url) {
        const match = pr.html_url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (match) {
          owner = match[1];
          repo = match[2];
          console.log(`[AI] Extracted repository from PR URL: ${owner}/${repo}`);
        } else {
          // Log error - we need repository information
          console.error('[AI] Could not extract repository information from PR URL');
          return {
            score: 0,
            confidence: 0,
            patterns: ['Repository information missing']
          };
        }
      } else {
        // Log error - we need repository information
        console.error('[AI] Repository information missing from PR object');
        return {
          score: 0,
          confidence: 0,
          patterns: ['Repository information missing']
        };
      }
    }
    
    // Add error handling for missing PR number
    if (!pr.number) {
      console.error('[AI] Missing PR number, cannot detect AI usage');
      return {
        score: 0,
        confidence: 0,
        patterns: []
      };
    }
    
    // Extract installation ID from PR data
    let installationId: number | undefined;
    
    // First check if installation ID is in the main webhook payload
    if (pr.installation && pr.installation.id) {
      installationId = pr.installation.id;
      console.log(`[AI] Extracted installationId from webhook payload: ${installationId}`);
    } 
    // Check if installation ID is in repository.account structure (database format)
    else if (pr.repository?.account?.installationId) {
      installationId = parseInt(pr.repository.account.installationId, 10);
      console.log(`[AI] Extracted installationId from repository.account: ${installationId}`);
    }
    
    if (!installationId) {
      console.warn('[AI] No installation ID found in webhook payload, will try to use fallback token');
    } else {
      console.log(`[AI][VALIDATION] Installation ID extraction successful: ${installationId} from ${pr.installation ? 'webhook payload' : 'repository.account'}`);
    }

    // Get installation token if we have an installation ID
    let octokit: Octokit;
    if (installationId) {
      try {
        // Dynamically import getInstallationToken to avoid circular dependencies
        const { getInstallationToken } = await import('@/core/eventProcessor');
        const installationToken = await getInstallationToken(installationId);
        console.log(`[AI] Successfully obtained installation token for installation ${installationId}`);
        
        // Add validation log with token prefix for verification
        const tokenPrefix = installationToken ? installationToken.substring(0, 4) + '...' : 'null';
        console.log(`[AI][VALIDATION] Token acquisition successful for installation ${installationId}, token prefix: ${tokenPrefix}`);
        
        octokit = new Octokit({
          auth: installationToken,
        });
      } catch (tokenError) {
        console.error(`[AI] Error getting installation token: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`);
        console.log('[AI] Falling back to default GitHub token from environment');
        
        // Fall back to default token
        octokit = new Octokit({
          auth: process.env.GITHUB_TOKEN,
        });
      }
    } else {
      // Use default token if no installation ID
      console.log('[AI] Using default GitHub token from environment');
      octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
      });
    }

    // Get PR files with better error handling
    let files;
    try {
      files = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: pr.number,
      });
      console.log(`[AI] Successfully retrieved ${files.data.length} files for PR #${pr.number}`);
      
      // Add validation log for successful API call
      console.log(`[AI][VALIDATION] GitHub API call successful for ${owner}/${repo} with PR #${pr.number}, ${files.data.length} files retrieved`);
    } catch (error) {
      // Properly handle the unknown error type
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[AI] Error getting PR files: ${errorMessage}`);
      return {
        score: 0,
        confidence: 0,
        patterns: ['Error retrieving PR files']
      };
    }
    
    // Track detected patterns
    const detectedPatterns: string[] = [];
    let patternMatches = 0;
    
    // Analyze each file for AI patterns
    for (const file of files.data) {
      // Use patch data for initial analysis
      let content = file.patch || '';
      
      // If patch is small, try to get the full file content for better analysis
      if (file.additions + file.deletions < 1000) { // Only for reasonably sized files
        try {
          console.log(`[AI] Attempting to get full content for ${file.filename}`);
          const fullContent = await octokit.repos.getContent({
            owner,
            repo,
            path: file.filename,
            ref: 'HEAD' // Get latest version
          });
          
          // Check if we got actual content back (not null or empty string)
          if (fullContent.data && typeof fullContent.data === 'object' && 'content' in fullContent.data) {
            console.log(`[AI] Successfully retrieved full content for ${file.filename}`);
            // Handle potential base64 encoded content
            const fileContent = fullContent.data.content || '';
            const encoding = (fullContent.data as any).encoding || 'utf-8';
            
            if (encoding === 'base64' && fileContent) {
              try {
                const decodedContent = Buffer.from(fileContent, 'base64').toString('utf-8');
                console.log(`[AI] Successfully decoded base64 content for ${file.filename} (${decodedContent.length} chars)`);
                content = decodedContent;
              } catch (decodeError) {
                console.error(`[AI] Error decoding base64 content: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`);
                console.log(`[AI] Falling back to patch data for ${file.filename}`);
              }
            }
          } else {
            console.log(`[AI] No content returned for ${file.filename}, using patch data instead`);
          }
        } catch (error) {
          // Properly handle the unknown error type
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log(`[AI] Using patch data for ${file.filename} as full content could not be retrieved: ${errorMessage}`);
          // Continue with patch data
        }
      } else {
        console.log(`[AI] File ${file.filename} too large (${file.additions + file.deletions} lines), using patch data`);
      }
      
      // Check for AI patterns
      for (const pattern of AI_PATTERNS) {
        if (pattern.test(content)) {
          patternMatches++;
          const patternName = pattern.toString().replace(/^\/|\/i$/g, '');
          if (!detectedPatterns.includes(patternName)) {
            detectedPatterns.push(patternName);
          }
        }
      }
      
      // Check for style consistency (AI code often has very consistent style)
      const styleConsistency = analyzeStyleConsistency(content);
      if (styleConsistency > 0.9) {
        patternMatches++;
        if (!detectedPatterns.includes('High style consistency')) {
          detectedPatterns.push('High style consistency');
        }
      }
    }
    
    // Calculate AI usage score (0-100)
    // Higher score means more likely to be AI-generated
    const totalChecks = files.data.length * (AI_PATTERNS.length + 1); // +1 for style check
    const score = Math.min(100, (patternMatches / Math.max(1, totalChecks)) * 100);
    
    // Calculate confidence level
    const confidence = Math.min(100, 50 + (detectedPatterns.length * 10));
    
    // Log detailed AI usage detection results with same format as OpenAI responses
    console.log(`[AI][AI_DETECTION_RESULT] PR #${pr.number} - ${owner}/${repo}:`, {
      score,
      confidence,
      patternMatchCount: patternMatches,
      totalChecks,
      detectedPatterns,
      filesAnalyzed: files.data.length,
      timestamp: new Date().toISOString()
    });
    
    return {
      score,
      confidence,
      patterns: detectedPatterns
    };
  } catch (error) {
    // Properly handle the unknown error type
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[AI] Error detecting AI usage: ${errorMessage}`);
    
    // Include stack trace for better debugging
    if (error instanceof Error && error.stack) {
      console.error(`[AI] Stack trace: ${error.stack}`);
    }
    
    // Return a more informative result
    return {
      score: 0,
      confidence: 0,
      patterns: [`Error: ${errorMessage}`]
    };
  }
}

/**
 * Analyze code style consistency
 * Returns a value between 0-1 where higher values indicate more consistent style
 */
function analyzeStyleConsistency(content: string): number {
  // Simple implementation - can be enhanced with more sophisticated analysis
  const lines = content.split('\n');
  
  // Check indentation consistency
  const indentations = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.length - line.trimLeft().length);
  
  const uniqueIndents = new Set(indentations);
  const indentConsistency = 1 - (uniqueIndents.size / Math.max(1, indentations.length));
  
  // Check line length consistency
  const lineLengths = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.length);
  
  const avgLength = lineLengths.reduce((sum, len) => sum + len, 0) / Math.max(1, lineLengths.length);
  const lengthVariance = lineLengths.reduce((sum, len) => sum + Math.pow(len - avgLength, 2), 0) / Math.max(1, lineLengths.length);
  const lengthConsistency = 1 - Math.min(1, Math.sqrt(lengthVariance) / avgLength);
  
  // Combined consistency score
  return (indentConsistency * 0.6) + (lengthConsistency * 0.4);
}