import { prisma } from '@/utils/prisma';
import { getRepositoryConfigFromPayload } from '@/utils/repoConfig';
import { GitHubClient } from '@/github/githubClient';
import { analyzeCode } from '@/ai/aiProcessor';
import {
  calculateMetrics,
  calculateEfficiencyScore,
  calculateWellnessScore,
  calculateQualityScore,
  calculateOverallScore
} from './metrics';
import { generateFeedback } from '@/core/feedbackGenerator';
import { detectAccountType } from '@/core/accountTypeDetector';
import { handleInstallationEvent } from '@/core/installationHandler';
import { identifyDeveloperPersona } from './persona/personaIdentifier';
import { createPersonaSnapshot } from './persona/personaEvolution';
import { analyzeSentiment, isOffensiveContent } from '../ai/sentimentAnalyzer';
import {
  onPullRequestCreated,
  onPullRequestMerged,
  onReviewSubmitted
} from './persona/personaSnapshotHooks';
import { AccountType } from '@/models/types';
import { checkForAchievements } from '@/core/achievements/achievementChecker';
import { encryptContent, decryptContent, isEncrypted } from '@/utils/encryption';
import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

/**
 * Get installation token for GitHub App
 * @param installationId Installation ID
 * @returns Installation token
 */
export async function getInstallationToken(installationId: number): Promise<string | null> {
  try {
    console.log(`Getting installation token for ID ${installationId}`);
    
    // Get App ID
    const appId = process.env.GITHUB_APP_ID;
    if (!appId) {
      console.error("Missing GitHub App ID");
      return null;
    }
    
    // Load private key
    let privateKey = process.env.GITHUB_PRIVATE_KEY || '';
    
    // Handle newlines in the key
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }
    
    try {
      // Use Octokit's auth mechanism
      const { createAppAuth } = require('@octokit/auth-app');
      
      // Create authentication object
      const auth = createAppAuth({
        appId: appId,
        privateKey: privateKey
      });
      
      // Get installation token
      const { token } = await auth({
        type: 'installation',
        installationId: installationId
      });
      
      console.log(`Successfully obtained installation token`);
      return token;
    } catch (authError: any) {
      console.error("Authentication error:", authError.message);
      return null;
    }
  } catch (error: any) {
    console.error(`Failed to get installation token:`, error.message);
    return null;
  }
}

/**
 * Process a GitHub webhook event
 * @param eventName The name of the event
 * @param payload The event payload
 * @param deliveryId The webhook delivery ID
 */
export async function processEvent(
  eventName: string,
  payload: any,
  deliveryId: string
) {
  console.log(`[EVENT_PROCESSOR][${deliveryId}] Starting to process ${eventName} event`);
  
  try {
    // Log relevant payload data based on event type
    if (eventName === 'pull_request') {
      const prAction = payload.action || 'unknown';
      const prNumber = payload.pull_request?.number || 'unknown';
      const repoName = payload.repository?.full_name || 'unknown';
      console.log(`[EVENT_PROCESSOR][${deliveryId}] Processing PR #${prNumber} ${prAction} in ${repoName}`);
    } else if (eventName === 'installation') {
      const installAction = payload.action || 'unknown';
      const account = payload.installation?.account?.login || 'unknown account';
      console.log(`[EVENT_PROCESSOR][${deliveryId}] Processing installation ${installAction} for ${account}`);
    } else {
      console.log(`[EVENT_PROCESSOR][${deliveryId}] Processing ${eventName} event with payload type: ${typeof payload}`);
    }
    
    // Route to appropriate handler based on event type
    console.log(`[EVENT_PROCESSOR][${deliveryId}] Routing to handler for ${eventName}`);
    switch (eventName) {
      case 'installation':
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Calling handleInstallationEvent`);
        await handleInstallationEvent(payload);
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Completed handleInstallationEvent`);
        break;
        
      case 'pull_request':
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Calling handlePullRequestEvent`);
        await handlePullRequestEvent(payload);
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Completed handlePullRequestEvent`);
        break;
        
      case 'pull_request_review':
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Calling handleReviewEvent`);
        await handleReviewEvent(payload);
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Completed handleReviewEvent`);
        break;
        
      case 'push':
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Calling handlePushEvent`);
        await handlePushEvent(payload);
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Completed handlePushEvent`);
        break;
        
      case 'issue_comment':
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Calling handleIssueCommentEvent`);
        await handleIssueCommentEvent(payload);
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Completed handleIssueCommentEvent`);
        break;
        
      // Handle other event types...
      default:
        console.log(`[EVENT_PROCESSOR][${deliveryId}] Ignoring unhandled event type: ${eventName}`);
    }
    
    // Mark event as processed
    console.log(`[EVENT_PROCESSOR][${deliveryId}] Updating webhook status to 'processed'`);
    await prisma.webhookEvent.update({
      where: { id: deliveryId },
      data: { status: 'processed', processedAt: new Date() }
    });
    console.log(`[EVENT_PROCESSOR][${deliveryId}] Successfully marked webhook as processed`);
  } catch (error: any) {
    console.error(`[EVENT_PROCESSOR][${deliveryId}] Error processing ${eventName} event:`, error);
    console.error(`[EVENT_PROCESSOR][${deliveryId}] Error stack:`, error.stack);
    console.error(`[EVENT_PROCESSOR][${deliveryId}] Error details:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
    
    // Try to extract more readable error message
    const errorMessage = error.message || 'Unknown error';
    
    // Mark event as failed
    console.log(`[EVENT_PROCESSOR][${deliveryId}] Updating webhook status to 'failed'`);
    try {
      await prisma.webhookEvent.update({
        where: { id: deliveryId },
        data: { 
          status: 'failed', 
          error: errorMessage,
          processedAt: new Date()
        }
      });
      console.log(`[EVENT_PROCESSOR][${deliveryId}] Successfully marked webhook as failed`);
    } catch (dbError: any) {
      console.error(`[EVENT_PROCESSOR][${deliveryId}] Failed to update webhook status:`, dbError);
    }
    
    // Add to retry queue if appropriate
    if (isRetryableError(error)) {
      console.log(`[EVENT_PROCESSOR][${deliveryId}] Error is retryable, adding to retry queue`);
      await addToRetryQueue(deliveryId);
    }
  }
}

/**
 * Handle a pull request event
 * @param payload The event payload
 */
async function handlePullRequestEvent(payload: any) {
  // Early validation
  if (!payload || !payload.pull_request || !payload.repository) {
    console.error('[EVENT_PROCESSOR] Invalid pull request event payload: missing required data');
    console.error('[EVENT_PROCESSOR] Payload keys:', Object.keys(payload || {}));
    return;
  }

  const { action, pull_request, repository, installation } = payload;

  // Safely extract account ID from various possible locations in the payload
  let accountId;
  if (payload.installation && payload.installation.account && payload.installation.account.id) {
    // Standard installation event with account info
    accountId = payload.installation.account.id.toString();
  } else if (payload.organization && payload.organization.id) {
    // Events with organization context
    accountId = payload.organization.id.toString();
  } else if (repository.owner && repository.owner.id) {
    // Repository events with owner info
    accountId = repository.owner.id.toString();
  } else if (payload.sender && payload.sender.id) {
    // Fallback to sender ID if nothing else available
    accountId = payload.sender.id.toString();
  } else {
    console.error('Unable to determine account ID from pull request event payload');
    return;
  }

  console.log(`[EVENT_PROCESSOR] PR #${pull_request.number} ${action} in ${repository.full_name}`);
  
  const repoId = repository.id.toString();
  const repoFullName = repository.full_name;
  const [owner, repo] = repoFullName.split('/');
  const prNumber = pull_request.number;
  
  // Get installation ID safely
  const installationId = installation && installation.id ? 
    installation.id.toString() : null;
  
  if (!installationId) {
    console.error('Missing installation ID in pull request event');
    return;
  }
  
  try {
    // Get installation token
    const token = await getInstallationToken(parseInt(installationId));
    if (!token) {
      console.error(`Failed to get installation token for ID ${installationId}`);
      return;
    }
    
    // Create GitHub client with repository information from the payload
    const github = new GitHubClient(token, owner, repo);
    
    // Common processing for all PR actions
    await ensureRepositoryExists(repoId, repoFullName, accountId);
    
    // Ensure user exists if we have user data
    if (pull_request.user && pull_request.user.id) {
      await ensureUserExists(
        pull_request.user.id.toString(), 
        pull_request.user.login, 
        accountId
      );
    }
  
    // Action-specific processing
    switch (action) {
      case 'opened':
      case 'reopened':
        // Get PR details
        const prData = await github.getPullRequest(owner, repo, prNumber);
        
        // Store PR in database - Access raw data directly since GitHubClient methods return raw API response
        const pr = await storePullRequest(prData, accountId, repoId);
        
        // Store PR files in database
        const prFiles = await github.getPullRequestFiles(owner, repo, prNumber);
        await storePullRequestFiles(pr.id, prFiles);
        
        // Link commits to PR
        await linkCommitsToPullRequest(pr.id, owner, repo, prNumber, github);
        
        // Trigger persona snapshot for PR creation
        if (action === 'opened') {
          await onPullRequestCreated(pr);
          console.log(`Triggered persona snapshot for PR #${prNumber} creation`);
        }
        
        break;
        
      case 'closed':
        // Update PR status in database
        await updatePullRequestStatus(
          pull_request.id.toString(),
          pull_request.merged ? 'MERGED' : 'CLOSED',
          pull_request.merged_at,
          pull_request.closed_at
        );
        
        // If PR was merged, analyze it and create a comprehensive comment
        if (pull_request.merged) {
          console.log(`Processing merged PR #${prNumber} for account ID: ${accountId}`);
          
          // Get PR details
          const mergedPrData = await github.getPullRequest(owner, repo, prNumber);
          
          // Get PR files
          const mergedPrFiles = await github.getPullRequestFiles(owner, repo, prNumber);
          
          // Store or update PR in database
          const mergedPr = await storePullRequest(mergedPrData, accountId, repoId);
          
          // Store PR files in database
          await storePullRequestFiles(mergedPr.id, mergedPrFiles);
          
          // Link commits to PR
          await linkCommitsToPullRequest(mergedPr.id, owner, repo, prNumber, github);
          
          // Analyze the PR and create a comment since it's merged
          // Pass the token explicitly to ensure it's available for AI analysis
          const prWithToken = { ...mergedPr, installationToken: token };
          await analyzePullRequest(
            prWithToken.id,
            mergedPrFiles,
            github,
            owner,
            repo,
            prNumber,
            true
          );
          
          // Calculate and award points using the same PR ID
          await calculateAndAwardPoints(mergedPr.id);
          
          // Trigger persona snapshot for PR merge
          await onPullRequestMerged(mergedPr);
          console.log(`Triggered persona snapshot for PR #${prNumber} merge`);
        }
        break;
        
      case 'synchronize': // PR updated with new commits
        // Store or update PR data
        const syncedPr = await storePullRequest(pull_request, accountId, repoId);
        
        // Update PR files
        const syncedPrFiles = await github.getPullRequestFiles(owner, repo, prNumber);
        await storePullRequestFiles(syncedPr.id, syncedPrFiles);
        
        // Link commits to PR
        await linkCommitsToPullRequest(syncedPr.id, owner, repo, prNumber, github);
        
        break;
        
      case 'labeled':
        // Handle label added to PR
        if (payload.label && pull_request.id) {
          console.log(`Label "${payload.label.name}" added to PR #${prNumber}`);
          
          // Note: We currently don't store labels in our database
          // GitHub manages labels directly, we just track the event
          // If storing labels is needed, update the Prisma schema to include a labels relation
          console.log(`GitHub label "${payload.label.name}" added to PR #${prNumber}`);
        }
        break;
        
      case 'unlabeled':
        // Handle label removed from PR
        console.log(`Label removed from PR #${prNumber}`);
        break;
        
      default:
        console.log(`Skipping unhandled PR action: ${action}`);
    }
  } catch (error) {
    console.error(`Error processing PR event (${action}) for repo ${repoFullName}:`, error);
    throw error; // Rethrow to allow the main processEvent function to handle it
  }
}

/**
 * Associate commits with a pull request
 * This is critical for efficiency metrics to work properly
 * @param prId The pull request ID
 * @param owner Repository owner
 * @param repo Repository name
 * @param prNumber Pull request number
 * @param github GitHub client instance
 */
async function linkCommitsToPullRequest(prId: string, owner: string, repo: string, prNumber: number, github: any) {
  console.log(`[PR_COMMITS] Linking commits to PR #${prNumber}`);
  
  try {
    // Fetch commits for this PR from GitHub
    const prCommits = await github.getPullRequestCommits(owner, repo, prNumber);
    
    if (!prCommits || prCommits.length === 0) {
      console.log(`[PR_COMMITS] No commits found for PR #${prNumber}`);
      return;
    }
    
    console.log(`[PR_COMMITS] Found ${prCommits.length} commits for PR #${prNumber}`);
    
    let linkedCount = 0;
    
    // Process each commit and link to PR
    for (const commitData of prCommits) {
      // Find the commit in our database
      const commit = await prisma.commit.findFirst({
        where: {
          // Look for the commit by SHA
          OR: [
            { sha: commitData.sha },
            { id: commitData.sha }
          ]
        }
      });
      
      if (commit) {
        // Link commit to PR if not already linked
        const existingLink = await prisma.pullRequest.findFirst({
          where: {
            id: prId,
            commits: {
              some: {
                id: commit.id
              }
            }
          }
        });
        
        if (!existingLink) {
          // Connect commit to PR
          await prisma.pullRequest.update({
            where: { id: prId },
            data: {
              commits: {
                connect: {
                  id: commit.id
                }
              }
            }
          });
          linkedCount++;
        }
      } else {
        // Commit not found in database, create it
        console.log(`[PR_COMMITS] Commit ${commitData.sha.substring(0, 7)} not found in database, creating it`);
        
        // Get PR to get repository info
        const pr = await prisma.pullRequest.findUnique({
          where: { id: prId },
          include: { repository: true }
        });
        
        if (!pr) {
          console.log(`[PR_COMMITS] Cannot create commit: PR ${prId} not found`);
          continue;
        }
        
        // Create a placeholder author if necessary
        let authorId;
        const authorData = commitData.author || commitData.commit?.author;
        
        if (authorData) {
          const user = await prisma.user.findFirst({
            where: {
              OR: [
                { id: authorData.id?.toString() },
                { login: authorData.login || authorData.name },
                ...(authorData.email ? [{ email: authorData.email }] : [])
              ]
            }
          });
          
          if (user) {
            authorId = user.id;
          } else {
            // Create placeholder user
            const newUser = await prisma.user.create({
              data: {
                id: authorData.id?.toString() || `commit-author-${Date.now()}`,
                login: authorData.login || authorData.name || `unknown-${Date.now()}`,
                email: authorData.email,
                name: authorData.name,
                accountId: pr.repository.accountId
              }
            });
            authorId = newUser.id;
          }
        } else {
          console.log(`[PR_COMMITS] No author data for commit ${commitData.sha.substring(0, 7)}`);
          continue;
        }
        
        // Create the commit
        const newCommit = await prisma.commit.create({
          data: {
            id: commitData.sha,
            sha: commitData.sha,
            message: commitData.commit.message,
            authorId,
            repositoryId: pr.repositoryId,
            committedAt: new Date(commitData.commit.author.date),
            pullRequests: {
              connect: {
                id: prId
              }
            }
          }
        });
        
        console.log(`[PR_COMMITS] Created and linked commit ${newCommit.sha.substring(0, 7)}`);
        linkedCount++;
      }
    }
    
    console.log(`[PR_COMMITS] Linked ${linkedCount} commits to PR #${prNumber}`);
    
    // Update firstCommitAt timestamp on the PR if it doesn't have one
    const earliestCommit = await prisma.commit.findFirst({
      where: {
        pullRequests: {
          some: {
            id: prId
          }
        }
      },
      orderBy: {
        committedAt: 'asc'
      }
    });
    
    if (earliestCommit) {
      await prisma.pullRequest.update({
        where: { id: prId },
        data: {
          firstCommitAt: earliestCommit.committedAt
        }
      });
      
      console.log(`[PR_COMMITS] Updated firstCommitAt: ${earliestCommit.committedAt}`);
    }
  } catch (error) {
    console.error(`[PR_COMMITS] Error linking commits to PR #${prNumber}:`, error);
  }
}

/**
 * Handle a review event
 * @param payload The event payload
 */
async function handleReviewEvent(payload: any) {
  // Early validation
  if (!payload || !payload.review || !payload.pull_request || !payload.repository) {
    console.error('Invalid review event payload: missing required data');
    return;
  }

  const { action, review, pull_request, repository } = payload;

  // Safely extract account ID from various possible locations in the payload
  let accountId;
  if (payload.installation && payload.installation.account && payload.installation.account.id) {
    // Standard installation event with account info
    accountId = payload.installation.account.id.toString();
  } else if (payload.organization && payload.organization.id) {
    // Events with organization context
    accountId = payload.organization.id.toString();
  } else if (repository.owner && repository.owner.id) {
    // Repository events with owner info
    accountId = repository.owner.id.toString();
  } else if (payload.sender && payload.sender.id) {
    // Fallback to sender ID if nothing else available
    accountId = payload.sender.id.toString();
  } else {
    console.error('Unable to determine account ID from review event payload');
    return;
  }

  console.log(`Processing review event for account ID: ${accountId}`);
  
  // Safely access required IDs
  if (!pull_request.id || !review.user || !review.user.id) {
    console.error('Missing required IDs in review event payload');
    return;
  }
  
  // Get installation ID safely
  const installationId = payload.installation && payload.installation.id ? 
    payload.installation.id.toString() : null;
  
  if (!installationId) {
    console.error('Missing installation ID in review event');
    return;
  }
  
  const prId = pull_request.id.toString();
  const reviewerId = review.user.id.toString();
  
  try {
    // Get installation token if needed for GitHub operations
    const token = await getInstallationToken(parseInt(installationId));
    
    // We can still proceed with database operations even without a token
    // as they don't require GitHub API access
    
    // Ensure user exists
    await ensureUserExists(reviewerId, review.user.login, accountId);
    
    // Store review in database
    await storeReview(review, prId, reviewerId);
    
    // Update PR with reviewer
    await addReviewerToPullRequest(prId, reviewerId);
    
    // Award points for review
    await awardPointsForReview(reviewerId, prId, review.state);
    
    // Trigger persona snapshot for review submission
    const prData = await prisma.pullRequest.findUnique({
      where: { id: prId }
    });
    
    if (prData && action === 'submitted') {
      await onReviewSubmitted(review, prData);
      console.log(`Triggered persona snapshot for review on PR #${pull_request.number}`);
    }
    
    // If we have a token, perform GitHub API operations
    if (token) {
      const github = new GitHubClient(token);
      // Cast to any to safely access methods that might not be fully defined in the type
      const githubAny = github as any;
      
      // Additional GitHub operations could go here
      console.log(`GitHub client available for review event on PR #${pull_request.number}`);
    }
  } catch (error) {
    console.error(`Error processing review event:`, error);
    throw error; // Rethrow to allow the main processEvent function to handle it
  }
}

/**
 * Handle a push event
 * @param payload The event payload
 */
async function handlePushEvent(payload: any) {
  if (!payload || !payload.repository) {
    console.error('Invalid push event payload: missing repository data');
    return;
  }
  
  const repository = payload.repository;
  const commits = payload.commits || [];
  const pusher = payload.pusher;
  
  // Safely extract account ID from various possible locations
  let accountId;
  if (payload.organization && payload.organization.id) {
    accountId = payload.organization.id.toString();
  } else if (repository.owner && repository.owner.id) {
    accountId = repository.owner.id.toString();
  } else if (payload.sender && payload.sender.id) {
    accountId = payload.sender.id.toString();
  } else {
    console.error('Unable to determine account ID from push event payload');
    return;
  }
  
  const repoId = repository.id.toString();
  const repoName = repository.full_name;
  
  console.log(`Processing push event for repository ${repoName} (${repoId}) under account ${accountId}`);
  
  // Ensure repository exists
  await ensureRepositoryExists(repoId, repoName, accountId);
  
  // Process commits
  if (commits && commits.length > 0) {
    console.log(`Processing ${commits.length} commits`);
    for (const commit of commits) {
      await processCommit(commit, repoId, accountId);
    }
  } else {
    console.log('No commits to process in this push event');
  }
}

async function processCommit(commit: any, repoId: string, accountId: string) {
  console.log(`[COMMIT_PROCESSOR] Processing commit: ${commit.id || '(unknown id)'}`);
  console.log(`[COMMIT_PROCESSOR] Commit author data:`, JSON.stringify(commit.author || {}, null, 2));
  
  try {
    // GitHub webhook payload provides author name and email, not ID
    const authorEmail = commit.author?.email;
    const authorName = commit.author?.name;
    
    if (!authorEmail && !authorName) {
      console.log(`[COMMIT_PROCESSOR] Skipping commit ${commit.id}: Missing author information`);
      return;
    }
    
    console.log(`[COMMIT_PROCESSOR] Looking up user for ${authorName || ''} (${authorEmail || 'no email'})`);
    
    // Look up user by email or create a placeholder user
    let authorId;
    
    // Try to find existing user by email
    const user = authorEmail ? await prisma.user.findFirst({
      where: { email: authorEmail }
    }) : null;
    
    if (user) {
      console.log(`[COMMIT_PROCESSOR] Found existing user by email: ${user.id} (${user.name || user.login})`);
      authorId = user.id;
    } else {
      console.log(`[COMMIT_PROCESSOR] No user found by email. Creating placeholder user for commit author.`);
      // Generate a safe login from name or use a placeholder
      const safeLogin = authorName 
        ? authorName.replace(/\s+/g, '').toLowerCase().substring(0, 20)
        : `commit-author-${Date.now()}`;
        
      // Create or get placeholder user for this commit
      const result = await prisma.user.upsert({
        where: { 
          email: authorEmail || `${safeLogin}@placeholder.com` 
        },
        update: {
          name: authorName || 'Unknown User'
        },
        create: {
          id: uuidv4(), // Generate a UUID for the new user
          email: authorEmail || `${safeLogin}@placeholder.com`,
          name: authorName || 'Unknown User',
          accountId,
          login: safeLogin
        }
      });
      authorId = result.id;
      console.log(`[COMMIT_PROCESSOR] Created/updated placeholder user: ${authorId}`);
    }
    
    console.log(`[COMMIT_PROCESSOR] Storing commit data with authorId: ${authorId}`);
    
    // Calculate file counts with null handling
    const added = Array.isArray(commit.added) ? commit.added.length : 0;
    const removed = Array.isArray(commit.removed) ? commit.removed.length : 0;
    const modified = Array.isArray(commit.modified) ? commit.modified.length : 0;
    const changedFiles = added + removed + modified;
    
    // Store commit
    await prisma.commit.upsert({
      where: { id: commit.id },
      update: {
        message: commit.message,
        committedAt: new Date(commit.timestamp),
        authorId // Update author ID if found later
      },
      create: {
        id: commit.id,
        sha: commit.id,
        message: commit.message || '',
        repositoryId: repoId,
        authorId,
        committedAt: new Date(commit.timestamp || Date.now()),
        additions: 0, // GitHub doesn't provide this in push events
        deletions: 0, // GitHub doesn't provide this in push events
        changedFiles
      }
    });
    
    console.log(`[COMMIT_PROCESSOR] Successfully stored commit ${commit.id} with ${changedFiles} changed files`);
  } catch (error) {
    console.error(`[COMMIT_PROCESSOR] Error processing commit:`, error);
    // Log request data for debugging
    console.error(`[COMMIT_PROCESSOR] Commit data:`, JSON.stringify({
      id: commit.id,
      message: commit.message?.substring(0, 100), // Truncate long messages
      author: commit.author,
      repoId,
      accountId
    }, null, 2));
  }
}

/**
 * Analyze a pull request
 * @param prId The pull request ID
 * @param files The files changed in the PR
 * @param github The GitHub client
 * @param owner The repository owner
 * @param repo The repository name
 * @param prNumber The pull request number
 * @param createComment Whether to create a comment with the analysis
 */
async function analyzePullRequest(
  prId: string,
  files: any[],
  github: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  createComment: boolean = false
) {
  try {
    // Get PR data from database with author's persona and dimensions
    const pullRequest = await prisma.pullRequest.findUnique({
      where: { id: prId },
      include: {
        author: {
          include: {
            persona: true,
            personaDimensions: true
          }
        },
        repository: {
          include: {
            account: true
          }
        }
      }
    });

    if (!pullRequest) {
      console.log(`PR not found: ${prId}`);
      return;
    }

    // Get decrypted description if needed for analysis
    const description = await getPRDescription(prId);
    if (description) {
      pullRequest.description = description;
    }

    // Get PR from database
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      include: {
        repository: {
          include: {
            account: true
          }
        },
        author: {
          include: {
            persona: true,
            personaDimensions: true
          }
        }
      }
    });
  
    if (!pr) {
      throw new Error(`PR ${prId} not found in database`);
    }
  
    // Get account type
    const accountType = pr.repository.account.type;
  
    // Calculate metrics
    const metrics = await calculateMetrics(pr, files, accountType);
  
    // Store metrics
    await storeMetrics(prId, metrics);
  
    // Calculate scores
    const accountId = pr.repository.account.id;
    const scores = {
      efficiency: await calculateEfficiencyScore(metrics.efficiency, accountId),
      wellness: await calculateWellnessScore(metrics.wellness, accountId),
      quality: await calculateQualityScore(metrics.quality, accountId)
    };
    
    const overallScore = await calculateOverallScore(scores, accountId);
  
    // Update PR with scores
    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        efficiencyScore: scores.efficiency,
        wellnessScore: scores.wellness,
        qualityScore: scores.quality,
        overallScore
      }
    });

    // Import the AI efficiency suggestion generator
    const { generateAIEfficiencySuggestions } = await import('@/ai/aiEfficiencyCalculator');
    
    // Generate AI suggestions for efficiency improvements if enough data is available
    try {
      // Generate suggestions
      const suggestions = await generateAIEfficiencySuggestions(prId);
      
      // Store suggestions in database
      if (suggestions.length > 0) {
        console.log(`Storing ${suggestions.length} AI efficiency suggestions for PR #${prNumber}`);
        
        for (const suggestion of suggestions) {
          await prisma.aISuggestion.create({
            data: {
              pullRequestId: suggestion.pullRequestId,
              category: suggestion.category,
              impactArea: suggestion.impactArea,
              message: suggestion.message,
              estimatedTimeSaving: Math.round(suggestion.estimatedTimeSaving),
              impactLevel: suggestion.impactLevel,
              isImplemented: false,
              beforeScore: suggestion.beforeScore,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          });
        }
      }
    } catch (error) {
      console.error('Error generating AI efficiency suggestions:', error);
      // Continue with PR analysis even if suggestion generation fails
    }
  
    // Analyze code patterns using AI
    console.log(`Starting OpenAI code analysis for PR #${prNumber} (files: ${files.length})`);
    // Convert Prisma AccountType to the type expected by analyzeCode
    const analysisAccountType = accountType === 'ORGANIZATION' 
      ? AccountType.ORGANIZATION 
      : AccountType.PERSONAL;
    const codeAnalysis = await analyzeCode(files, analysisAccountType);
    console.log(`Completed OpenAI code analysis for PR #${prNumber}, feedback items: ${codeAnalysis.feedback.length}`);
  
    // Store AI analysis feedback
    await storeFeedback(prId, codeAnalysis);
  
    if (createComment) {
      // If we're creating a comment (on PR merge), identify persona
      if (pullRequest.author) {
        // Attempt to identify developer persona if they have enough activity
        console.log(`Identifying persona for user: ${pullRequest.author.id}`);
        const personaResult = await identifyDeveloperPersona(pullRequest.author.id);
        
        if (personaResult.primary) {
          console.log(`Identified primary persona for ${pullRequest.author.login}: ${personaResult.primary.name}`);
          
          // Create a persona snapshot to track the user's evolution
          await createPersonaSnapshot(pullRequest.author.id, prId);
          console.log(`Created persona snapshot for ${pullRequest.author.login}`);
        } else {
          console.log(`Not enough activity to identify persona for ${pullRequest.author.login}`);
        }
      }

      // Generate PR comment using the metrics and scores we just calculated
      console.log(`Creating PR comment on GitHub: ${owner}/${repo}#${prNumber}`);
      const feedback = await generateFeedback({
        ...pr,
        efficiencyScore: scores.efficiency,
        wellnessScore: scores.wellness,
        qualityScore: scores.quality,
        overallScore
      }, scores, metrics, codeAnalysis, accountType);
      await github.createPullRequestComment(owner, repo, prNumber, feedback);
      
      // Add a score label to the PR
      console.log(`Adding score label to PR: ${owner}/${repo}#${prNumber}`);
      await addScoreLabelToPR(github, owner, repo, prNumber, overallScore);

      // Check for new achievements earned by the author
      if (pullRequest.author) {
        console.log(`Checking achievements for user: ${pullRequest.author.id}`);
        const newAchievements = await checkForAchievements(pullRequest.author.id);
        
        if (newAchievements.length > 0) {
          console.log(`User ${pullRequest.author.login} earned ${newAchievements.length} new achievements!`);
          
          // Create achievement notification comment if achievements were earned
          const achievementNotification = generateAchievementNotification(
            pullRequest.author.login, 
            newAchievements
          );
          
          if (achievementNotification) {
            await github.createPullRequestComment(owner, repo, prNumber, achievementNotification);
          }
        }
      }
    } else {
      console.log(`Metrics updated for PR #${prNumber} (no comment created)`);
    }
  } catch (error) {
    console.error(`Error processing PR event:`, error);
    throw error; // Rethrow to allow the main processEvent function to handle it
  }
}

/**
 * Handle an issue comment event (comments on PRs/issues)
 * @param payload The event payload
 */
async function handleIssueCommentEvent(payload: any) {
  // Only process PR comments (issues that are pull requests)
  if (!payload.issue.pull_request) {
    console.log('Ignoring comment on regular issue (not a PR)');
    return;
  }

  const { action, comment, issue, repository } = payload;
  
  // We only care about created or edited comments
  if (action !== 'created' && action !== 'edited') {
    console.log(`Skipping comment action: ${action}`);
    return;
  }

  // Safely extract account ID from various possible locations in the payload
  let accountId;
  if (payload.installation && payload.installation.account && payload.installation.account.id) {
    // Standard installation event with account info
    accountId = payload.installation.account.id.toString();
  } else if (payload.organization && payload.organization.id) {
    // Events with organization context
    accountId = payload.organization.id.toString();
  } else if (repository.owner && repository.owner.id) {
    // Repository events with owner info
    accountId = repository.owner.id.toString();
  } else if (payload.sender && payload.sender.id) {
    // Fallback to sender ID if nothing else available
    accountId = payload.sender.id.toString();
  } else {
    console.error('Unable to determine account ID from issue comment event payload');
    return;
  }

  console.log(`Processing PR comment (${action}) for account ID: ${accountId}`);
  
  // Get installation ID safely
  const installationId = payload.installation && payload.installation.id ? 
    payload.installation.id.toString() : null;
  
  if (!installationId) {
    console.error('Missing installation ID in issue comment event');
    return;
  }
  
  try {
    // Get installation token
    const token = await getInstallationToken(parseInt(installationId));
    if (!token) {
      console.error(`Failed to get installation token for ID ${installationId}`);
      return;
    }
    
    // Create GitHub client
    const github = new GitHubClient(token);
    
    // Ensure repository exists
    const repoId = repository.id.toString();
    const repoFullName = repository.full_name;
    await ensureRepositoryExists(repoId, repoFullName, accountId);
    
    // Ensure user exists if we have user data
    if (comment.user && comment.user.id) {
      await ensureUserExists(
        comment.user.id.toString(), 
        comment.user.login, 
        accountId
      );
    }
    
    // Get the PR ID from the issue's pull_request URL
    const prUrl = issue.pull_request.url;
    const prUrlParts = prUrl.split('/');
    const prNumber = parseInt(prUrlParts[prUrlParts.length - 1]);
    
    // Get PR data to get the pull request ID in our system
    const [owner, repo] = repoFullName.split('/');
    const prData = await github.getPullRequest(owner, repo, prNumber);
    const prId = prData?.id.toString() || null;
    
    if (!prId) {
      console.error(`Failed to get PR ID for PR #${prNumber}`);
      return;
    }
    // Store comment in database
    await storeComment(comment, prId, comment.user.id.toString());
    
    // Log processing
    console.log(`Stored comment ${comment.id} for PR #${prNumber}`);
  } catch (error) {
    console.error(`Error processing issue comment event:`, error);
    throw error; // Rethrow to allow the main processEvent function to handle it
  }
}

// Helper functions (to be implemented)
async function ensureRepositoryExists(repoId: string, fullName: string, accountId: string) {
  try {
    // First check if the account exists and create it if it doesn't
    const existingAccount = await prisma.account.findUnique({
      where: { id: accountId }
    });
    
    if (!existingAccount) {
      console.log(`Creating account with ID ${accountId} for repository ${fullName}`);
      
      // Extract owner name from repository full name
      const [ownerName] = fullName.split('/');
      
      // Create the account
      await prisma.account.create({
        data: {
          id: accountId,
          name: ownerName,
          type: 'ORGANIZATION', // Default type, can be updated later
          installationId: 'unknown', // Will be updated when we process installation events
        }
      });
      
      console.log(`Account created for ${ownerName} (${accountId})`);
    }
    
    // Now check if repository exists and create if not
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) {
      const [owner, name] = fullName.split('/');
      await prisma.repository.create({
        data: {
          id: repoId,
          name,
          fullName,
          accountId
        }
      });
      
      console.log(`Repository created: ${fullName} (${repoId})`);
    }
  } catch (error) {
    console.error(`Error ensuring repository exists for ${fullName}:`, error);
    throw error; // Rethrow to allow error handling higher up
  }
}

async function ensureUserExists(userId: string, login: string, accountId: string) {
  try {
    // First check if the account exists and create it if it doesn't
    const existingAccount = await prisma.account.findUnique({
      where: { id: accountId }
    });
    
    if (!existingAccount) {
      console.log(`Creating account with ID ${accountId} for user ${login}`);
      
      // Create the account
      await prisma.account.create({
        data: {
          id: accountId,
          name: login, // Use login as a fallback name
          type: 'ORGANIZATION', // Default type, can be updated later
          installationId: 'unknown', // Will be updated when we process installation events
        }
      });
      
      console.log(`Account created for ${login} (${accountId})`);
    }
    
    // Check if user exists
    const user = await prisma.user.findUnique({ 
      where: { id: userId }
    });
    
    if (!user) {
      // Create the user with primary account
      await prisma.user.create({
        data: {
          id: userId,
          login,
          accountId, // Set as primary account
          points: 0,
          level: 1
        }
      });
      
      // Create the organization membership separately
      await prisma.userOrganization.create({
        data: {
          userId,
          accountId,
          role: 'member'
        }
      });
      
      console.log(`User created: ${login} (${userId})`);
    } else {
      // Check if the user is already a member of this account/organization
      const existingMembership = await prisma.userOrganization.findUnique({
        where: {
          userId_accountId: {
            userId,
            accountId
          }
        }
      });
      
      if (!existingMembership) {
        // Add user to the organization if they're not already a member
        await prisma.userOrganization.create({
          data: {
            userId,
            accountId,
            role: 'member'
          }
        });
        
        console.log(`Added user ${login} to account/organization ${accountId}`);
      }
    }
  } catch (error) {
    console.error(`Error ensuring user exists for ${login}:`, error);
    throw error; // Rethrow to allow error handling higher up
  }
}

async function storePullRequest(prData: any, accountId: string, repoId: string) {
  const description = prData.body || null;
  const state = mapPRState(prData.state, prData.merged);
  
  // Encrypt description if PR is closed or merged and not already encrypted
  const shouldEncrypt = state === 'CLOSED' || state === 'MERGED';
  const processedDescription = shouldEncrypt && description && !isEncrypted(description) ? 
    encryptContent(description) : description;

  try {
    // Create or update PR in database
    return await prisma.pullRequest.upsert({
      where: { id: prData.id.toString() },
      update: {
        title: prData.title,
        description: processedDescription,
        state: state,
        additions: prData.additions,
        deletions: prData.deletions,
        changedFiles: prData.changed_files,
        mergedAt: prData.merged_at,
        closedAt: prData.closed_at,
        updatedAt: new Date()
      },
      create: {
        id: prData.id.toString(),
        number: prData.number,
        title: prData.title,
        description: processedDescription,
        repositoryId: repoId,
        authorId: prData.user.id.toString(),
        state: state,
        additions: prData.additions,
        deletions: prData.deletions,
        changedFiles: prData.changed_files,
        reviewerIds: [],
        firstCommitAt: null,
        mergedAt: prData.merged_at,
        closedAt: prData.closed_at
      }
    });
  } catch (error) {
    console.error(`Error storing PR ${prData.id}:`, error);
    throw error;
  }
}

function mapPRState(state: string, merged: boolean): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (merged) return 'MERGED';
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

async function updatePullRequestStatus(
  prId: string,
  state: 'CLOSED' | 'MERGED',
  mergedAt: string | null,
  closedAt: string
) {
  try {
    // Get current PR data
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId }
    });

    if (!pr) {
      console.error(`PR ${prId} not found when updating status`);
      return;
    }

    // Only encrypt if not already encrypted and description exists
    let description = pr.description;
    if (description && !isEncrypted(description)) {
      try {
        description = encryptContent(description);
      } catch (error) {
        console.error(`Error encrypting PR ${prId} description:`, error);
        // Keep original description if encryption fails
        description = pr.description;
      }
    }

    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        state,
        description,
        mergedAt,
        closedAt: new Date(closedAt)
      }
    });
  } catch (error) {
    console.error(`Error updating PR ${prId} status:`, error);
    throw error;
  }
}

/**
 * Get PR description, decrypting if necessary
 * @param prId The pull request ID
 * @returns Decrypted description or null
 */
async function getPRDescription(prId: string): Promise<string | null> {
  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId }
    });

    if (!pr || !pr.description) {
      return null;
    }

    // Check if content is encrypted
    if (isEncrypted(pr.description)) {
      try {
        return decryptContent(pr.description);
      } catch (error) {
        // Log specific error details for debugging
        if (error instanceof Error) {
          console.error(`Error decrypting PR ${prId} description: ${error.message}`);
          if (error.stack) {
            console.error(`Stack trace: ${error.stack}`);
          }
        }
        
        // Check for specific error types
        if (error instanceof TypeError) {
          console.error(`Invalid encryption format for PR ${prId}`);
        } else if (error instanceof Error && error.message?.includes('ENCRYPTION_KEY')) {
          console.error(`Missing or invalid encryption key for PR ${prId}`);
        }
        
        return null;
      }
    }

    return pr.description;
  } catch (error) {
    console.error(`Error retrieving PR ${prId}:`, error);
    return null;
  }
}

async function calculateAndAwardPoints(prId: string) {
  // Get PR with scores and repository info
  const pr = await prisma.pullRequest.findUnique({
    where: { id: prId },
    include: { 
      author: true,
      repository: {
        include: {
          account: true
        }
      }
    }
  });
  
  if (!pr || !pr.overallScore) return;

  // Verify user belongs to the account
  const userOrg = await prisma.userOrganization.findUnique({
    where: {
      userId_accountId: {
        userId: pr.authorId,
        accountId: pr.repository.accountId
      }
    }
  });

  if (!userOrg) {
    console.error(`User ${pr.authorId} does not belong to account ${pr.repository.accountId}`);
    return;
  }
  
  // Calculate points based on scores
  const points = Math.round(pr.overallScore);
  
  // Award points to author
  await prisma.user.update({
    where: { 
      id: pr.authorId,
      accountId: pr.repository.accountId // Ensure points are awarded in correct account
    },
    data: {
      points: { increment: points }
    }
  });
  
  // Log point transaction
  const pointData: Prisma.PointTransactionCreateInput = {
    userId: pr.authorId,
    account: {
      connect: { id: pr.repository.accountId }
    },
    amount: points,
    reason: 'pr_merged',
    referenceId: prId,
    referenceType: 'pullrequest'
  };
  await prisma.pointTransaction.create({ data: pointData });
  
  // Update PR with awarded points
  await prisma.pullRequest.update({
    where: { id: prId },
    data: { pointsAwarded: points }
  });
  
  // Check for level progression within this account
  await checkAndUpdateUserLevel(pr.authorId, pr.repository.accountId);
}

async function storeReview(review: any, prId: string, reviewerId: string) {
  await prisma.review.upsert({
    where: { id: review.id.toString() },
    update: {
      state: mapReviewState(review.state),
      body: review.body || null,
      submittedAt: new Date(review.submitted_at)
    },
    create: {
      id: review.id.toString(),
      pullRequestId: prId,
      authorId: reviewerId,
      state: mapReviewState(review.state),
      body: review.body || null,
      submittedAt: new Date(review.submitted_at)
    }
  });
}

function mapReviewState(state: string): 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' {
  switch (state) {
    case 'APPROVED': return 'APPROVED';
    case 'CHANGES_REQUESTED': return 'CHANGES_REQUESTED';
    case 'COMMENTED': return 'COMMENTED';
    default: return 'PENDING';
  }
}

async function addReviewerToPullRequest(prId: string, reviewerId: string) {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: prId }
  });
  
  if (!pr) return;
  
  // Add reviewer if not already present
  if (!pr.reviewerIds.includes(reviewerId)) {
    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        reviewerIds: { push: reviewerId },
        reviewers: { connect: { id: reviewerId } }
      }
    });
  }
}

async function awardPointsForReview(userId: string, prId: string, reviewState: string) {
  // Award points based on review state
  let points = 0;
  switch (reviewState) {
    case 'APPROVED': points = 10; break;
    case 'CHANGES_REQUESTED': points = 15; break;
    case 'COMMENTED': points = 5; break;
    default: points = 0;
  }
  
  if (points > 0) {
    // Get PR data to get the account ID
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      include: {
        repository: true
      }
    });

    if (!pr) {
      console.error(`PR ${prId} not found when awarding review points`);
      return;
    }

    // Update user points
    await prisma.user.update({
      where: { id: userId },
      data: {
        points: { increment: points }
      }
    });
    
    // Log point transaction
    const reviewPointData: Prisma.PointTransactionCreateInput = {
      userId,
      account: {
        connect: { id: pr.repository.accountId }
      },
      amount: points,
      reason: 'review_submitted',
      referenceId: prId,
      referenceType: 'pullrequest'
    };
    await prisma.pointTransaction.create({ data: reviewPointData });
    
    // Check for level progression
    await checkAndUpdateUserLevel(userId, pr.repository.accountId);
  }
}

async function storeMetrics(prId: string, metrics: any) {
  console.log(`[METRICS] Storing metrics for PR ${prId}`);
  
  try {
    // First, delete existing metrics for this PR to avoid duplicates
    const deletedCount = await prisma.pRMetric.deleteMany({
      where: { pullRequestId: prId }
    });
    
    if (deletedCount.count > 0) {
      console.log(`[METRICS] Deleted ${deletedCount.count} existing metrics for PR ${prId}`);
    }
    
    // Store each metric
    const storedMetrics = await Promise.all(Object.keys(metrics).map(async (category) => {
      return Promise.all(Object.keys(metrics[category]).map(async (name) => {
        try {
          const metricValue = metrics[category][name];
          let rawValue, score, unit;
          
          // Handle both object format and direct number format
          if (typeof metricValue === 'object' && metricValue !== null) {
            rawValue = metricValue.value || metricValue.raw;
            score = metricValue.score;
            unit = metricValue.unit;
          } else {
            // If it's just a number, use it as both value and score
            rawValue = metricValue;
            score = metricValue;
          }
          
          // Skip undefined/null values
          if (rawValue === undefined || rawValue === null) {
            console.warn(`[METRICS] Skipping undefined/null value for ${category}.${name}`);
            return;
          }
          
          // Ensure values are numbers
          const numericRawValue = Number(rawValue);
          const numericScore = Number(score);
          
          if (isNaN(numericRawValue) || isNaN(numericScore)) {
            console.warn(`[METRICS] Skipping non-numeric value for ${category}.${name}: raw=${rawValue}, score=${score}`);
            return;
          }
          
          // Create the metric
          const createData: Prisma.PRMetricUncheckedCreateInput = {
            pullRequestId: prId,
            name,
            category,
            value: numericScore,
            rawValue: numericRawValue,
            unit: unit || null,
            description: metricValue.description || getMetricDescription(name, category)
          };
          
          await prisma.pRMetric.create({ data: createData });
        } catch (error) {
          console.error(`[METRICS] Error storing metric ${category}.${name}:`, error);
        }
      }));
    }));
    
    // Calculate scores based on metrics
    await updatePRScores(prId);
    
    // Update PR with metrics calculation timestamp
    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        metricsCalculatedAt: new Date()
      }
    });
    
    console.log(`[METRICS] Successfully stored metrics for PR ${prId}`);
  } catch (error) {
    console.error(`[METRICS] Error storing metrics for PR ${prId}:`, error);
  }
}

/**
 * Update PR scores based on stored metrics
 * @param prId The pull request ID
 */
async function updatePRScores(prId: string) {
  try {
    // Get PR to determine account type
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      include: {
        repository: {
          include: {
            account: true
          }
        }
      }
    });
    
    if (!pr) {
      console.error(`[METRICS] PR ${prId} not found when updating scores`);
      return;
    }
    
    // Get all metrics for this PR
    const storedMetrics = await prisma.pRMetric.findMany({
      where: { pullRequestId: prId }
    });
    
    // Organize metrics by category
    interface StoredMetric {
      value: number;
      rawValue?: number;
      unit?: string;
      description?: string;
    }

    const metricsByCategory: Record<string, Record<string, StoredMetric>> = {
      efficiency: {},
      wellness: {},
      quality: {}
    };
    
    storedMetrics.forEach(metric => {
      if (!metricsByCategory[metric.category]) {
        metricsByCategory[metric.category] = {};
      }
      metricsByCategory[metric.category][metric.name] = {
        value: metric.value,
        rawValue: metric.rawValue || undefined,
        unit: metric.unit || undefined,
        description: metric.description || getMetricDescription(metric.name, metric.category)
      };
    });

    // Transform metrics into MetricValue format
    const metricsWithValue = {
      efficiency: Object.entries(metricsByCategory.efficiency).reduce((acc, [key, metric]) => ({ 
        ...acc, [key]: { 
          raw: metric.rawValue || metric.value,
          score: metric.value,
          unit: metric.unit || 'score',
          description: metric.description || getMetricDescription(key, 'efficiency')
        }
      }), {}),
      wellness: Object.entries(metricsByCategory.wellness).reduce((acc, [key, metric]) => ({ 
        ...acc, [key]: { 
          raw: metric.rawValue || metric.value,
          score: metric.value,
          unit: metric.unit || 'score',
          description: metric.description || getMetricDescription(key, 'wellness')
        }
      }), {}),
      quality: Object.entries(metricsByCategory.quality).reduce((acc, [key, metric]) => ({ 
        ...acc, [key]: { 
          raw: metric.rawValue || metric.value,
          score: metric.value,
          unit: metric.unit || 'score',
          description: metric.description || getMetricDescription(key, 'quality')
        }
      }), {})
    };
    
    // Calculate scores
    const accountId = pr.repository.account.id;
    const scores = {
      efficiency: await calculateEfficiencyScore(metricsWithValue.efficiency, accountId),
      wellness: await calculateWellnessScore(metricsWithValue.wellness, accountId),
      quality: await calculateQualityScore(metricsWithValue.quality, accountId)
    };
    
    const overallScore = await calculateOverallScore(scores, accountId);
    
    // Update PR with scores
    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        efficiencyScore: scores.efficiency,
        wellnessScore: scores.wellness,
        qualityScore: scores.quality,
        overallScore
      }
    });
    
    console.log(`[METRICS] Updated scores for PR ${prId}: efficiency=${scores.efficiency}, wellness=${scores.wellness}, quality=${scores.quality}, overall=${overallScore}`);
  } catch (error) {
    console.error(`[METRICS] Error updating PR scores for ${prId}:`, error);
  }
}

async function storeFeedback(prId: string, codeAnalysis: any) {
  // Store feedback items
  for (const item of codeAnalysis.feedback) {
    await prisma.pRFeedback.create({
      data: {
        pullRequestId: prId,
        type: item.type,
        message: item.message,
        codeContext: item.codeContext,
        fileLocation: item.fileLocation
      }
    });
  }
}

function generateSummary(scores: any, metrics: any) {
  // Placeholder for summary generation
  return `
- ## Wellcode.ai Analysis Summary
- 
- - Efficiency Score: ${Math.round(scores.efficiency)}/100
- - Wellness Score: ${Math.round(scores.wellness)}/100
- - Quality Score: ${Math.round(scores.quality)}/100
  `;
}

function generateDetailedReport(scores: any, metrics: any, codeAnalysis: any) {
  // Placeholder for detailed report generation
  return `
# Detailed Analysis

## Efficiency Metrics
- PR Size: ${metrics.efficiency.prSize} lines
- Cycle Time: ${metrics.efficiency.cycleTime} hours
- Review Response Time: ${metrics.efficiency.reviewResponseTime} hours

## Wellness Metrics
- After Hours Work: ${metrics.wellness.afterHoursWork}%
- Context Switching: ${metrics.wellness.contextSwitching} score
- Collaboration Balance: ${metrics.wellness.collaborationBalance} score

## Quality Metrics
- Test Coverage: ${metrics.quality.testCoverage}%
- Documentation: ${metrics.quality.documentation} score
- Code Complexity: ${metrics.quality.codeComplexity} score

## AI Efficiency Suggestions
${codeAnalysis.aiSuggestions?.length > 0 
  ? codeAnalysis.aiSuggestions.map((s: any) => 
    `- ${s.impactArea}: ${s.message} (Est. time saving: ${s.estimatedTimeSaving} min)`).join('\n')
  : '- No AI efficiency suggestions available yet.'}

## Code Analysis Feedback
${codeAnalysis.feedback.map((f: any) => `- ${f.type}: ${f.message}`).join('\n')}
  `;
}

async function checkAndUpdateUserLevel(userId: string, accountId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });
  
  if (!user) return;
  
  // Simple level calculation: level = points / 100 + 1
  const newLevel = Math.floor(user.points / 100) + 1;
  
  if (newLevel > user.level) {
    await prisma.user.update({
      where: { id: userId },
      data: { level: newLevel }
    });
  }
}

function isRetryableError(error: any) {
  // Determine if error is retryable
  return !error.message.includes('not found') && 
         !error.message.includes('invalid signature') &&
         !error.message.includes('already exists');
}

async function addToRetryQueue(deliveryId: string) {
  // Add failed event to retry queue
  console.log(`Adding event ${deliveryId} to retry queue`);
  // Implementation would depend on chosen queue solution (e.g., Redis, SQS, etc.)
}

// Helper function to add a score label to a PR
async function addScoreLabelToPR(
  github: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  score: number
): Promise<void> {
  try {
    // Remove any existing Wellcode score labels first
    const labels = await github.getIssueLabels(owner, repo, prNumber);
    const scoreLabels = labels
      .filter(label => 
        label.name.startsWith('Wellcode:') || 
        label.name.startsWith('Wellcode Score:')
      )
      .map(label => label.name);
    
    // Remove each score label
    for (const labelName of scoreLabels) {
      await github.removeLabelFromPullRequest(owner, repo, prNumber, labelName);
      console.log(`Removed existing score label: ${labelName}`);
    }
    
    // Generate label properties based on score
    const { name, color, description } = generateScoreLabelProps(score);
    
    // Add the label to the PR
    const result = await github.addLabelToPullRequest(
      owner, 
      repo, 
      prNumber, 
      name, 
      color, 
      description
    );
    
    if (result) {
      console.log(`Successfully added score label to PR #${prNumber}`);
    } else {
      console.warn(`Failed to add score label to PR #${prNumber}`);
    }
  } catch (error) {
    console.error(`Error adding score label to PR #${prNumber}:`, error);
  }
}

// Generate label properties based on a score
function generateScoreLabelProps(score: number): { name: string; color: string; description: string } {
  // Ensure score is in range 0-100
  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
  
  // Generate label based on score categories
  let category = "Unknown";
  let color = "cccccc"; // Default gray
  let description = "Code quality score from Wellcode.ai";
  
  if (normalizedScore >= 90) {
    category = "Excellent";
    color = "0e8a16"; // Bright green
    description = "Excellent code quality (90-100)";
  } else if (normalizedScore >= 75) {
    category = "Good";
    color = "85cf32"; // Light green
    description = "Good code quality (75-89)";
  } else if (normalizedScore >= 60) {
    category = "Average";
    color = "fbca04"; // Yellow
    description = "Average code quality (60-74)";
  } else if (normalizedScore >= 40) {
    category = "Needs Work";
    color = "f79232"; // Orange
    description = "Needs improvement (40-59)";
  } else {
    category = "Critical Issues";
    color = "d73a4a"; // Red
    description = "Significant issues detected (<40)";
  }
  
  // Include the actual score in the label name
  const name = `Wellcode Score: ${normalizedScore} - ${category}`;
  
  return { name, color, description };
}

/**
 * Store files from a pull request in the database
 * First deletes existing files for the PR to avoid duplicates
 * @param prId Pull request ID
 * @param files Files from GitHub API
 */
async function storePullRequestFiles(prId: string, files: any[]) {
  try {
    if (!files || files.length === 0) {
      console.log(`[PR_FILES] No files to store for PR ${prId}`);
      return;
    }
    
    console.log(`[PR_FILES] Storing ${files.length} files for PR ${prId}`);
    
    // First delete any existing files for this PR to avoid duplicates
    await prisma.pullRequestFile.deleteMany({
      where: { pullRequestId: prId }
    });
    
    // Store each file
    const storedFiles = await Promise.all(files.map(async (file) => {
      return prisma.pullRequestFile.create({
        data: {
          pullRequestId: prId,
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch
        }
      });
    }));
    
    console.log(`[PR_FILES] Successfully stored ${storedFiles.length} files for PR ${prId}`);
  } catch (error) {
    console.error(`[PR_FILES] Error storing files for PR ${prId}:`, error);
  }
}

/**
 * Store a comment in the database and analyze its sentiment
 * @param comment The comment data from GitHub
 * @param prId The pull request ID in our system
 * @param authorId The comment author's ID
 */
async function storeComment(comment: any, prId: string, authorId: string) {
  try {
    // First, get the comment body for sentiment analysis
    const commentBody = comment.body || '';
    
    // Analyze sentiment - using our analyzer with user info
    const sentimentScore = await analyzeSentiment(commentBody, comment.user);
    
    // Check for offensive language
    const isOffensive = await isOffensiveContent(commentBody, comment.user);
    
    // If offensive, lower the sentiment score significantly
    const adjustedScore = isOffensive ? Math.max(0, sentimentScore - 0.5) : sentimentScore;
    
    // Store or update the comment in the database
    await prisma.comment.upsert({
      where: { id: comment.id.toString() },
      update: {
        body: commentBody,
        sentimentScore: adjustedScore,
        updatedAt: new Date()
      },
      create: {
        id: comment.id.toString(),
        pullRequestId: prId,
        authorId: authorId,
        body: commentBody,
        sentimentScore: adjustedScore,
        createdAt: new Date(comment.created_at),
        updatedAt: new Date(comment.updated_at || comment.created_at)
      }
    });
    
    // Log offensive comments for potential moderation
    if (isOffensive) {
      console.warn(`⚠️ Potentially offensive comment detected: ID ${comment.id} on PR ${prId} (score: ${adjustedScore})`);
      
      // Optional: Add flag to database for moderation
      await prisma.comment.update({
        where: { id: comment.id.toString() },
        data: {
          // Assuming we add a field for flagging offensive content
          // flaggedForModeration: true
        }
      });
    }
    
    return adjustedScore;
  } catch (error) {
    console.error(`Error storing comment:`, error);
    throw error;
  }
}

/**
 * Generate a notification for new achievements
 * @param username The GitHub username
 * @param achievements Array of earned achievements
 * @returns Markdown formatted notification or null if no achievements
 */
function generateAchievementNotification(username: string, achievements: any[]): string | null {
  if (!achievements || achievements.length === 0) {
    return null;
  }
  
  let notification = `# 🏆 Achievement Unlocked!\n\n`;
  notification += `Congratulations @${username}! You've earned new achievements:\n\n`;
  
  // Add each achievement with its details
  achievements.forEach(achievement => {
    const rarityEmoji = getRarityEmoji(achievement.rarity);
    notification += `## ${rarityEmoji} ${achievement.name}\n`;
    notification += `**${achievement.description}**\n\n`;
    notification += `*+${achievement.points} points*\n\n`;
  });
  
  notification += `Keep up the great work! 🚀`;
  
  return notification;
}

/**
 * Get an emoji representation of rarity
 * @param rarity The rarity level
 * @returns Emoji string
 */
function getRarityEmoji(rarity: string): string {
  switch (rarity) {
    case 'common': return '🟢';
    case 'uncommon': return '🔵';
    case 'rare': return '🟣';
    case 'epic': return '🟠';
    case 'legendary': return '⭐';
    default: return '✨';
  }
}

/**
 * Get description for a metric based on its name and category
 */
export function getMetricDescription(name: string, category: string): string {
  const descriptions: Record<string, Record<string, string>> = {
    efficiency: {
      prSize: "Number of lines changed in the pull request",
      cycleTime: "Time from first commit to merge",
      reviewResponseTime: "Average time for first review response",
      commitFrequency: "Frequency of commits in the PR",
      wipManagement: "Concurrent open PRs by the same author",
      mergeFrequency: "Time since last merged PR",
      firstResponseTime: "Time to first review or comment",
      prIterations: "Number of review iterations",
      branchAge: "Age of the branch in days",
      prDependencies: "Number of dependent or blocking PRs",
      reviewTime: "Average time taken to review code changes",
      iterationSpeed: "Speed of implementing review feedback",
      codeVelocity: "Rate of code changes over time",
      deploymentFrequency: "Frequency of deployments",
      buildTime: "Time taken for build processes",
      automationLevel: "Level of process automation"
    },
    wellness: {
      workHoursPattern: "Distribution of work across hours of day",
      collaborationBalance: "Balance between solo work and collaborative efforts",
      communicationTone: "Sentiment analysis of comments and descriptions",
      breakPatterns: "Gaps in activity indicating breaks",
      feedbackReception: "How developer responds to feedback",
      contextSwitching: "Frequency of switching between unrelated tasks",
      workTypeBalance: "Balance between feature and maintenance work",
      featureWork: "Percentage of work classified as features or performance improvements",
      maintenanceWork: "Percentage of work classified as fixes, refactoring, maintenance, docs, or tests",
      proactiveWorkScore: "Measure of planned (proactive) vs urgent (reactive) work",
      maintenanceTrend: "Trend indicating changes in maintenance work patterns",
      workloadBalance: "Distribution of work across time",
      focusTime: "Continuous coding time periods",
      codeReviewLoad: "Review workload distribution"
    },
    quality: {
      testCoverage: "Percentage of code covered by tests",
      documentation: "Quality and completeness of documentation",
      codeComplexity: "Cyclomatic complexity of changes",
      bestPractices: "Adherence to coding best practices",
      securityIssues: "Number of security concerns identified",
      maintainability: "Code maintainability score",
      testQuality: "Quality and reliability of tests",
      documentationQuality: "Completeness and clarity of documentation",
      codeStyle: "Adherence to coding standards",
      bugDensity: "Number of bugs per unit of code",
      technicalDebt: "Accumulated technical debt",
      securityScore: "Code security assessment score",
      performanceScore: "Code performance assessment score",
      testPresence: "Presence of tests for new code",
      codePatterns: "Usage of recommended code patterns",
      prDescriptionQuality: "Quality of PR description and documentation",
      reviewThoroughness: "Thoroughness of code reviews",
      complexityTrends: "Trends in code complexity"
    }
  };

  return descriptions[category]?.[name] || `${category} metric: ${name}`;
}