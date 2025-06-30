import { PrismaClient } from '@prisma/client';
import { generateActionItems } from '@/ai/aiProcessor';

const prisma = new PrismaClient();

/**
 * Generate feedback for a PR
 * @param pr The pull request
 * @param scores The scores
 * @param metrics The metrics
 * @param codeAnalysis The code analysis
 * @param accountType The account type
 * @returns The feedback content
 */
export async function generateFeedback(
  pr: any, 
  scores: any, 
  metrics: any, 
  codeAnalysis: any, 
  accountType: any
): Promise<string> {
  // Validate account access
  if (!pr?.repository?.accountId) {
    console.error('Missing repository account ID');
    return 'Error: Unable to generate feedback';
  }

  // Get personalized action items from AI
  const aiAnalysis = await generateAIAnalysisSection(pr, scores, metrics, codeAnalysis);
  
  // Get review feedback section
  const reviewFeedbackSection = await generateReviewFeedbackSection(pr);
  
  // Get leaderboard for organization accounts
  let leaderboardSection = '';
  // Check both possible organization type locations
  const isOrganization = (pr.repository?.account?.type === 'ORGANIZATION') || 
                        (pr.account?.type === 'ORGANIZATION') ||
                        accountType === 'ORGANIZATION';
                        
  if (isOrganization) {
    leaderboardSection = await generateLeaderboard(pr.repository.accountId);
  }
  
  // Generate persona insights
  const personaInsights = await generatePersonaInsights(pr);
  
  // Generate the PR comment with a more logical flow and clear structure
  const feedback = await generatePRComment(
    pr,
    scores,
    metrics,
    codeAnalysis,
    isOrganization,
    aiAnalysis,
    reviewFeedbackSection,
    leaderboardSection,
    personaInsights
  );

  return feedback;
}

/**
 * Generate a PR comment with metrics and feedback
 */
export async function generatePRComment(
  pr: any,
  scores: any,
  metrics: any,
  codeAnalysis: any,
  accountType: any,
  aiAnalysis: any,
  reviewFeedbackSection: string,
  leaderboardSection: string,
  personaInsights: string
): Promise<string> {
  // Format the scores section
  const scoresSection = formatScores(pr);
  
  // Extract key metrics
  const keyMetrics = extractKeyMetrics(metrics);
  
  // Generate developer profile section
  const developerProfile = await generateSimplifiedPersonaSection(pr);
  
  // Generate recommended actions (simplified from AI analysis)
  const recommendedActions = generateActionRecommendations(aiAnalysis, metrics);
  
  // Calculate points for this PR
  const prPoints = calculatePoints(scores);
  
  // Generate activity and progress section
  const activitySection = await generateActivitySection(pr, prPoints);
  
  // Get work distribution data
  const workDistribution = getWorkDistribution(metrics);
  
  return `## Wellcode.ai Insights 🚀

${scoresSection}

### Key Metrics:
- ✅ **Efficiency**: ${Math.round(pr.efficiencyScore || 0)}/100
  ${keyMetrics.efficiency.map(m => `- ${m.name}: ${m.value} (${m.score}% ${m.emoji})`).join('\n  ')}
- 👍 **Wellness**: ${Math.round(pr.wellnessScore || 0)}/100
  ${keyMetrics.wellness.map(m => `- ${m.name}: ${m.value} (${m.score}% ${m.emoji})`).join('\n  ')}
- ${Math.round(pr.qualityScore || 0) < 60 ? '⚠️' : '✨'} **Quality**: ${Math.round(pr.qualityScore || 0)}/100
  ${keyMetrics.quality.map(m => `- ${m.name}: ${m.value} (${m.score}% ${m.emoji})`).join('\n  ')}

### Work Distribution:
- 📊 **Feature Work**: ${workDistribution.feature}% (Target: 70%)
- 🔧 **Maintenance Work**: ${workDistribution.maintenance}% (Target: 30%)
- 🚀 **Proactive Work**: ${workDistribution.proactive}/100
- 📈 **Work Type Balance**: ${workDistribution.balance}%
- 📊 **Maintenance Trend**: ${workDistribution.trend}/100

${developerProfile}

### Recommended Actions:
${recommendedActions.map((action, index) => `${index + 1}. 📝 **${action.title}** - ${action.description}`).join('\n')}

### Activity & Progress:
${activitySection}

${leaderboardSection}

${personaInsights}

<div align="right"><a href="https://www.wellcode.ai/dashboard">View Full Report →</a></div>
`;

}

/**
 * Format the scores section of the PR comment
 * @param pr The pull request data containing the scores
 */
function formatScores(pr: any): string {
  // Use the actual scores directly from the database
  const efficiency = Math.round(pr.efficiencyScore || 0);
  const wellness = Math.round(pr.wellnessScore || 0);
  const quality = Math.round(pr.qualityScore || 0);
  const overall = Math.round(pr.overallScore || 0);

  // Get emoji for overall score
  const scoreEmoji = getEmojiForScore({ overall });

  return `**Overall Score: ${overall}/100** ${scoreEmoji}`;
}

/**
 * Extract key metrics for the simplified report
 */
function extractKeyMetrics(metrics: any) {
  // Safety check in case metrics is undefined or null
  if (!metrics) {
    return {
      efficiency: [],
      wellness: [],
      quality: []
    };
  }
  
  const getTopMetrics = (category: string, count: number = 2) => {
    // Get the category metrics object
    const categoryMetrics = metrics?.[category] || {};
    
    // Safety check if categoryMetrics exists
    if (!categoryMetrics || typeof categoryMetrics !== 'object') {
      console.warn(`Category metrics for ${category} is missing or invalid:`, categoryMetrics);
      return [];
    }
    
    // Convert the object to an array of metrics for sorting
    const metricsArray = Object.entries(categoryMetrics).map(([name, data]: [string, any]) => ({
      name,
      ...data
    }));
    
    if (!Array.isArray(metricsArray)) {
      console.warn(`Failed to convert ${category} metrics to array`);
      return [];
    }
    
    // Sort by significance - highest and lowest scores are most significant
    const sortedMetrics = metricsArray.sort((a, b) => {
      const aDistance = Math.abs((a.score || 0) - 50);
      const bDistance = Math.abs((b.score || 0) - 50);
      return bDistance - aDistance;
    });
    
    // Take top metrics and format them
    return sortedMetrics.slice(0, count).map(m => ({
      name: formatMetricName(m.name),
      value: formatMetricValue(m.value || m.raw, m.unit),
      score: m.score || 0,
      emoji: getScoreEmoji(m.score || 0)
    }));
  };

  return {
    efficiency: getTopMetrics('efficiency'),
    wellness: getTopMetrics('wellness'),
    quality: getTopMetrics('quality')
  };
}

/**
 * Format metric name to be more readable
 */
function formatMetricName(name: string): string {
  if (!name) return '';
  
  // Convert camelCase to Title Case with spaces
  const formatted = name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase());
  
  // Handle special cases
  return formatted
    .replace('P R', 'PR')
    .replace('W I P', 'WIP');
}

/**
 * Format metric value with unit
 */
function formatMetricValue(value: any, unit: string): string {
  if (value === undefined || value === null) return '-';
  
  // Format number based on type
  if (typeof value === 'number') {
    if (unit === 'percent') return `${Math.round(value * 100)}%`;
    if (unit === 'days' || unit === 'day') return `${value}d`;
    if (unit === 'hours' || unit === 'hour') return `${value}h`;
    if (unit === 'minutes' || unit === 'minute') return `${value}min`;
  }
  
  return `${value}`;
}

/**
 * Generate a simplified persona section
 */
async function generateSimplifiedPersonaSection(pr: any): Promise<string> {
  if (!pr.author?.personaId) {
    return '### Developer Profile: Not Available';
  }
  
  try {
    // Get persona from the database
    const persona = await prisma.userPersona.findUnique({
      where: { id: pr.author.personaId }
    });
    
    if (!persona) {
      return '### Developer Profile: Not Available';
    }
    
    // Get user dimensions
    const dimensions = await prisma.personaDimension.findFirst({
      where: { userId: pr.author.id }
    });
    
    // Get user's growth area from PR analysis
    const { topGrowthArea, growthPercentage } = await calculateTopGrowthArea(pr.author.id);
    
    // Get persona name without "The " prefix if it exists
    const personaName = persona.name.replace(/^The\s+/i, '');
    
    // Format strengths as comma-separated list
    const strengths = (persona.strengthAreas || [])
      .slice(0, 3)
      .join(', ')
      .toLowerCase();
    
    // Dimension descriptions
    const problemSolving = dimensions ? getDimensionLabel(dimensions.problemSolving, 'problemSolving') : 'Balanced';
    const workStyle = dimensions ? getDimensionLabel(dimensions.workStyle, 'workStyle') : 'Balanced';
    const codeFocus = dimensions ? getDimensionLabel(dimensions.codeFocus, 'codeFocus') : 'Balanced';
    const projectManagement = dimensions ? getDimensionLabel(dimensions.projectManagement, 'projectManagement') : 'Balanced';
    
    return `### Developer Profile: ${personaName}
- 💪 **Strengths**: ${strengths}
- 📈 **Growth Area**: ${topGrowthArea}${growthPercentage ? ` (+${growthPercentage}%)` : ''}
- 🧠 **Dimensions**: ${problemSolving} problem-solving, ${workStyle}, ${codeFocus}-focused`;
  } catch (error) {
    console.error('Error generating persona section:', error);
    return '### Developer Profile: Error Retrieving Data';
  }
}

/**
 * Generate action recommendations from AI analysis
 */
function generateActionRecommendations(aiAnalysis: string, metrics: any): Array<{ title: string, description: string }> {
  const recommendations = [];
  
  // Try to extract action items from AI analysis
  if (aiAnalysis) {
    const actionItemsMatch = aiAnalysis.match(/### \d+\. 📌 ([^(]+) \(Impact:[^\)]+\)\n\n([^#]+)/g);
    
    if (actionItemsMatch) {
      for (const item of actionItemsMatch.slice(0, 3)) {
        const titleMatch = item.match(/### \d+\. 📌 ([^(]+) \(Impact:/);
        const descriptionMatch = item.match(/\n\n([^#]+)/);
        
        if (titleMatch && descriptionMatch) {
          const title = titleMatch[1].trim();
          // Take only first sentence of description
          const description = descriptionMatch[1].trim().split(/\.\s+/)[0] + '.';
          
          recommendations.push({ title, description });
        }
      }
    }
  }
  
  // If we couldn't extract from AI analysis, generate from metrics
  if (recommendations.length === 0) {
    // Find most problematic metrics
    const allMetrics = [
      ...(metrics.efficiency || []),
      ...(metrics.wellness || []),
      ...(metrics.quality || [])
    ];
    
    const lowScoreMetrics = allMetrics
      .filter(m => m.score < 40)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);
    
    for (const metric of lowScoreMetrics) {
      recommendations.push({
        title: `Improve ${formatMetricName(metric.name)}`,
        description: metric.description || `Current score: ${metric.score}%. Work on improving this area.`
      });
    }
    
    // If we still don't have recommendations, add generic ones
    if (recommendations.length === 0) {
      recommendations.push({
        title: 'Add more detailed PR descriptions',
        description: 'Include context, purpose, testing approach, and potential impacts.'
      });
    }
  }
  
  // Ensure we have at most 3 recommendations
  return recommendations.slice(0, 3);
}

/**
 * Generate activity and progress section
 */
async function generateActivitySection(pr: any, prPoints: number): Promise<string> {
  // Get user's recent activity
  const recentPRs = await prisma.pullRequest.findMany({
    where: {
      authorId: pr.author.id,
      state: 'MERGED',
      mergedAt: {
        gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
      }
    },
    orderBy: {
      mergedAt: 'desc'
    }
  });
  
  // Calculate total lines changed
  const totalLinesChanged = recentPRs.reduce((sum, pr) => {
    return sum + (pr.additions || 0) + (pr.deletions || 0);
  }, 0);
  
  // Calculate average PR score
  const avgScore = calculateAveragePRScore(recentPRs);
  
  // Get current level info
  const userTotalPoints = pr.author.points || 0;
  const currentLevelInfo = getLevelInfo(userTotalPoints);
  const nextLevelInfo = getNextLevelInfo(currentLevelInfo.level);
  
  // Calculate progress percentage to next level
  const pointsInCurrentLevel = userTotalPoints - currentLevelInfo.threshold;
  const pointsNeededForNextLevel = nextLevelInfo.threshold - currentLevelInfo.threshold;
  const progressPercentage = Math.round((pointsInCurrentLevel / pointsNeededForNextLevel) * 100);
  const pointsToNextLevel = nextLevelInfo.threshold - userTotalPoints;
  
  return `- 📊 **Recent**: ${recentPRs.length} PR${recentPRs.length !== 1 ? 's' : ''} merged, ${totalLinesChanged} lines changed
- 🏆 **This PR**: +${prPoints} points (${progressPercentage}% to next level)
- 🔝 **Rank**: #${pr.author.rank || '?'} on team leaderboard`;
}

/**
 * Generate team insights section for organization accounts
 */
async function generateTeamInsightsSection(pr: any, metrics: any): Promise<string> {
  // Validate account access
  if (!pr?.repository?.accountId) {
    return '';
  }

  // Get reviewers that belong to the same account
  const validReviewers = await prisma.userOrganization.findMany({
    where: {
      accountId: pr.repository.accountId,
      userId: {
        in: pr.reviewers?.map((r: any) => r.id) || []
      }
    }
  });

  const reviewerCount = validReviewers.length;

  // Check if we have enough reviewers
  if (reviewerCount === 0) {
    return `## 👥 Team Insights\n👥 Consider adding reviewers to get more feedback`;
  }
  
  if (reviewerCount > 2) {
    return `## 👥 Team Insights\n👥 Strong team engagement with ${reviewerCount} reviewers`;
  }
  
  return `## 👥 Team Insights\n👥 Adding more reviewers could help improve code quality and knowledge sharing`;
}

/**
 * Generate an AI-powered analysis section for the PR comment
 */
async function generateAIAnalysisSection(
  pr: any,
  scores: any,
  metrics: any,
  codeAnalysis: any
): Promise<string> {
  try {
    // Get personalized action items from OpenAI based on metrics history and PR context
    const aiAnalysis = await generateActionItems(
      pr.authorId,
      pr, // Pass the entire PR object for context
      metrics
    ).catch(error => {
      console.error('Error calling generateActionItems:', error);
      return null;
    });
    
    // If no valid AI analysis, return empty string
    if (!aiAnalysis?.actionItems?.length || !aiAnalysis.overallRecommendation) {
      console.log('No valid AI analysis available, skipping section');
      return '';
    }
    
    // Format action items as markdown
    const actionItemsMarkdown = aiAnalysis.actionItems.map((item: { title: string, description: string, category: string, potentialImpact: number }, index: number) => `
### ${index + 1}. 📌 ${item.title} (Impact: ${item.potentialImpact}/10)

${item.description}

*Category: ${item.category.charAt(0).toUpperCase() + item.category.slice(1)}*
`).join('');
    
    // Format the AI analysis with personalized action items using pure markdown
    return `### 🧠 AI-Powered Recommendations

### 🚀 Personalized Action Items
${actionItemsMarkdown}`;
  } catch (error) {
    console.error('Error generating AI analysis section:', error);
    return ''; // Return empty string on error
  }
}

/**
 * Format suggestions
 */
function formatSuggestions(feedback: Array<{ type: string, message: string, fileLocation?: string | null }>): string {
  return feedback.map(item => {
    return `📝 ${item.message}${item.fileLocation ? ` (at ${item.fileLocation})` : ''}`;
  }).join('\n');
}

/**
 * Prioritize feedback
 */
function prioritizeFeedback(feedback: Array<{ type: string, message: string, fileLocation?: string | null }>): Array<{ type: string, message: string, fileLocation?: string | null }> {
  // Sort by type (warnings first, then suggestions)
  return feedback
    .sort((a, b) => a.type === 'warning' ? -1 : 1)
    .slice(0, 3); // Limit to top 3
}

/**
 * Calculate points earned from scores
 * @param scores The calculated scores
 * @returns Total points earned
 */
function calculatePoints(scores: any): number {
  // Use the same weights as defined in the metrics documentation
  const efficiency = Math.round(scores.efficiency * 0.45);
  const wellness = Math.round(scores.wellness * 0.15);
  const quality = Math.round(scores.quality * 0.40);
  
  return efficiency + wellness + quality;
}

/**
 * Get emoji based on overall score
 * @param scores The calculated scores
 * @returns Appropriate emoji
 */
function getEmojiForScore(scores: any): string {
  // Use the pre-calculated overall score
  const overall = Math.round(scores.overall || 0);
  
  if (overall >= 90) return '🌟';
  if (overall >= 80) return '✨';
  if (overall >= 70) return '👍';
  if (overall >= 60) return '🙂';
  return '🔍';
}

/**
 * Get level information based on points
 */
function getLevelInfo(points: number): { level: number, name: string, threshold: number } {
  // Define levels with their thresholds
  const levels = [
    { level: 1, name: 'Novice', threshold: 0 },
    { level: 2, name: 'Coder', threshold: 200 },
    { level: 3, name: 'Developer', threshold: 500 },
    { level: 4, name: 'Engineer', threshold: 1000 },
    { level: 5, name: 'Architect', threshold: 2000 },
    { level: 6, name: 'Master', threshold: 5000 }
  ];
  
  // Find the highest level that the points exceed the threshold for
  for (let i = levels.length - 1; i >= 0; i--) {
    if (points >= levels[i].threshold) {
      return levels[i];
    }
  }
  
  // Default to first level
  return levels[0];
}

/**
 * Get next level information
 */
function getNextLevelInfo(currentLevel: number): { level: number, name: string, threshold: number } {
  // Define levels with their thresholds
  const levels = [
    { level: 1, name: 'Novice', threshold: 0 },
    { level: 2, name: 'Coder', threshold: 200 },
    { level: 3, name: 'Developer', threshold: 500 },
    { level: 4, name: 'Engineer', threshold: 1000 },
    { level: 5, name: 'Architect', threshold: 2000 },
    { level: 6, name: 'Master', threshold: 5000 }
  ];
  
  // Find the next level
  for (let i = 0; i < levels.length - 1; i++) {
    if (levels[i].level === currentLevel) {
      return levels[i + 1];
    }
  }
  
  // If current level is the highest, return the highest level
  return levels[levels.length - 1];
}

/**
 * Get label for dimension value 
 * @param score The dimension score
 * @param dimensionType The type of dimension
 * @returns String label for the dimension value
 */
function getDimensionLabel(score: number, dimensionType: string): string {
  if (dimensionType === 'codeFocus') {
    if (score < 40) return 'Backend';
    if (score > 60) return 'Frontend';
    return 'Fullstack';
  }
  return score < 50 ? 'Low' : 'High';
}

/**
 * Generate a team leaderboard section for PR feedback
 * @param accountId The account ID
 * @param limitToTop Number of top users to show
 */
async function generateLeaderboard(accountId: string, limitToTop: number = 5): Promise<string> {
  try {
    // Get top users by points - already filtered by accountId to respect organization boundaries
    const topUsers = await prisma.user.findMany({
      where: {
        accountId, // This correctly filters to only show users in the same organization
        // Only include users with at least some activity
        points: {
          gt: 0
        }
      },
      orderBy: {
        points: 'desc'
      },
      take: limitToTop,
      select: {
        login: true,
        points: true,
        level: true
      }
    });

    if (topUsers.length === 0) {
      return '';
    }

    // Generate leaderboard markdown with improved visuals using markdown
    let leaderboardMd = `### 🏆 Team Leaderboard\n\n`;
    leaderboardMd += `| Rank | Developer | Level | Points |\n`;
    leaderboardMd += `|:----:|:---------:|:-----:|:------:|\n`;

    topUsers.forEach((user, index) => {
      // Add trophy emoji for top 3
      let rankEmoji = '';
      
      if (index === 0) {
        rankEmoji = '🥇';
      } else if (index === 1) {
        rankEmoji = '🥈';
      } else if (index === 2) {
        rankEmoji = '🥉';
      } else {
        rankEmoji = `${index + 1}`;
      }
      
      // Get level name instead of just number
      const levelName = getLevelName(user.level);
      
      leaderboardMd += `| ${rankEmoji} | @${user.login} | ${levelName} | ${user.points} |\n`;
    });

    return leaderboardMd;
  } catch (error) {
    console.error('Error generating leaderboard:', error);
    return '';
  }
}

/**
 * Generate review feedback section
 * @param pr The pull request data
 * @returns Review feedback section
 */
async function generateReviewFeedbackSection(pr: any): Promise<string> {
  try {
    // Check if we have review data
    if (!pr.reviewData) {
      return '';
    }
    
    const { reviewQualityScore, reviewCount, commentCount, reviewers, sentimentScore } = pr.reviewData;
    
    let messageText = '';
    
    // Generate appropriate message based on review quality
    if (reviewQualityScore >= 80) {
      messageText = 'This PR received high-quality review attention with thorough feedback and engaged discussions.';
    } else if (reviewQualityScore >= 50) {
      messageText = 'This PR received moderate review attention. More detailed feedback could help improve code quality further.';
    } else {
      messageText = 'This PR received minimal review attention. Consider requesting more thorough reviews to improve code quality and knowledge sharing.';
    }
    
    // Format the review quality section using markdown rather than HTML
    return `## 📋 Review Quality

**Review Score: ${reviewQualityScore}**

${messageText}

### 📊 Review Statistics

* 👥 ${reviewers.length} unique ${reviewers.length === 1 ? 'reviewer' : 'reviewers'}
* 💬 ${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}
* 📊 ${sentimentScore ? `${Math.round(sentimentScore)}/100 sentiment score` : 'No sentiment data'}
* ${reviewCount > 0 ? `✅ ${reviewCount} ${reviewCount === 1 ? 'review' : 'reviews'}` : '⚠️ No reviews yet'}`;
  } catch (error) {
    console.error('Error generating review feedback section:', error);
    return '';
  }
}

/**
 * Generate persona-specific insights for the developer
 * @param pr The pull request data
 * @returns Formatted insights section
 */
async function generatePersonaInsights(pr: any): Promise<string> {
  // Simply return empty string to remove this section from PR comments
  return '';
}

/**
 * Get emoji based on score value
 */
function getScoreEmoji(score: number): string {
  if (score >= 90) return '🌟';
  if (score >= 75) return '✨';
  if (score >= 60) return '👍';
  if (score >= 40) return '🔍';
  return '⚠️';
}

/**
 * Generate work type analysis section
 * @param metrics The metrics data
 * @param pr The pull request data
 * @returns Formatted work type analysis section
 */
function generateWorkTypeAnalysisSection(metrics: any, pr?: any): string {
  // This function is now replaced by getWorkDistribution
  return '';  // Return empty string to prevent errors in existing calls
}

/**
 * Generate detailed report
 */
function generateDetailedReport(scores: any, metrics: any, codeAnalysis: any): string {
  // This function is now replaced by the streamlined format
  return '';  // Return empty string to prevent errors in existing calls
}

/**
 * Get work type distribution from metrics
 */
function getWorkDistribution(metrics: any): { feature: number, maintenance: number, proactive: number, balance: number, trend: number } {
  // Default values if metrics aren't available - more reasonable defaults
  const defaults = { feature: 0, maintenance: 0, proactive: 0, balance: 50, trend: 0 };
  
  if (!metrics || !metrics.wellness) {
    console.warn('Missing wellness metrics for work distribution');
    return defaults;
  }
  
  try {
    // Convert metrics object structure to key-value pairs for easier access
    const wellnessMetrics = metrics.wellness || {};
    
    // Log metrics structure for debugging
    console.log('Wellness metrics for work distribution:', JSON.stringify(wellnessMetrics, null, 2));
    
    // Extract metrics with proper error handling - properly check all possible field locations
    const featureWork = getMetricValue(wellnessMetrics, 'featureWork', defaults.feature);
    const maintenanceWork = getMetricValue(wellnessMetrics, 'maintenanceWork', defaults.maintenance);
    const proactiveWork = getMetricValue(wellnessMetrics, 'proactiveWorkScore', defaults.proactive);
    const workTypeBalance = getMetricValue(wellnessMetrics, 'workTypeBalance', defaults.balance);
    const maintenanceTrend = getMetricValue(wellnessMetrics, 'maintenanceTrend', defaults.trend);
    
    return {
      feature: featureWork,
      maintenance: maintenanceWork,
      proactive: proactiveWork,
      balance: workTypeBalance,
      trend: maintenanceTrend
    };
  } catch (error) {
    console.error('Error extracting work distribution metrics:', error);
    return defaults;
  }
  
  // Helper function to extract metric values with proper fallbacks
  function getMetricValue(metrics: any, metricName: string, defaultValue: number): number {
    // Check all the ways a metric might be stored
    if (!metrics[metricName]) {
      return defaultValue;
    }
    
    const metric = metrics[metricName];
    
    // Try to get the value in various formats
    if (typeof metric === 'number') {
      return Math.round(metric);
    } else if (metric.score !== undefined) {
      return Math.round(metric.score);
    } else if (metric.raw !== undefined) {
      return Math.round(metric.raw);
    } else if (metric.value !== undefined) {
      // If value is already a percentage, use it directly
      return Math.round(metric.value);
    }
    
    return defaultValue;
  }
}

/**
 * Calculate growth metrics based on recent PRs
 */
function calculateGrowthMetrics(recentPRs: any[]): { topGrowthArea: string, growthPercentage: number } {
  if (!recentPRs || recentPRs.length < 2) {
    return { topGrowthArea: '', growthPercentage: 0 };
  }
  
  // Sort PRs by date (newest first)
  const sortedPRs = [...recentPRs].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  
  // Split into recent and older PRs
  const recentHalf = sortedPRs.slice(0, Math.ceil(sortedPRs.length / 2));
  const olderHalf = sortedPRs.slice(Math.ceil(sortedPRs.length / 2));
  
  if (recentHalf.length === 0 || olderHalf.length === 0) {
    return { topGrowthArea: '', growthPercentage: 0 };
  }
  
  // Calculate average scores for different metrics
  const getAvgScore = (prs: any[], metricName: string): number => {
    const scores = prs.map(pr => {
      const metric = pr.metrics?.find((m: any) => m.name === metricName);
      return metric?.value || 0;
    }).filter(score => score > 0);
    
    return scores.length > 0
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : 0;
  };
  
  // Calculate growth for different areas
  const growthAreas = [
    { name: 'Code Quality', metric: 'codeQuality' },
    { name: 'Documentation', metric: 'documentationQuality' },
    { name: 'PR Description', metric: 'prDescriptionQuality' },
    { name: 'Review Thoroughness', metric: 'reviewThoroughness' },
    { name: 'Test Coverage', metric: 'testCoverage' }
  ];
  
  // Calculate growth percentage for each area
  const growthPercentages = growthAreas.map(area => {
    const recentAvg = getAvgScore(recentHalf, area.metric);
    const olderAvg = getAvgScore(olderHalf, area.metric);
    
    // Avoid division by zero
    if (olderAvg === 0) return { ...area, growth: 0 };
    
    const growthPercent = ((recentAvg - olderAvg) / olderAvg) * 100;
    return { ...area, growth: growthPercent };
  });
  
  // Find the area with the highest growth
  const topGrowth = growthPercentages
    .filter(area => area.growth > 0)
    .sort((a, b) => b.growth - a.growth)[0];
  
  if (!topGrowth) {
    return { topGrowthArea: '', growthPercentage: 0 };
  }
  
  return {
    topGrowthArea: topGrowth.name,
    growthPercentage: Math.round(topGrowth.growth)
  };
}

/**
 * Calculate average PR score from recent PRs
 */
function calculateAveragePRScore(recentPRs: any[]): number {
  if (!recentPRs || recentPRs.length === 0) return 0;
  
  const scores = recentPRs.map(pr => pr.overallScore || 0).filter(score => score > 0);
  
  return scores.length > 0
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : 0;
}

/**
 * Calculate the top growth area for a user
 * @param userId The user ID
 * @returns Object with topGrowthArea and growthPercentage
 */
async function calculateTopGrowthArea(userId: string): Promise<{ topGrowthArea: string, growthPercentage: number }> {
  try {
    // Get user's recent PRs
    const sortedPRs = await prisma.pullRequest.findMany({
      where: {
        authorId: userId,
        state: 'MERGED',
        mergedAt: {
          not: null
        }
      },
      orderBy: {
        mergedAt: 'desc'
      },
      take: 10,
      include: {
        metrics: true
      }
    });
    
    // Split into recent and older PRs
    const recentHalf = sortedPRs.slice(0, Math.ceil(sortedPRs.length / 2));
    const olderHalf = sortedPRs.slice(Math.ceil(sortedPRs.length / 2));
    
    if (recentHalf.length === 0 || olderHalf.length === 0) {
      return { topGrowthArea: '', growthPercentage: 0 };
    }
    
    // Calculate average scores for different metrics
    const getAvgScore = (prs: any[], metricName: string): number => {
      const scores = prs.map(pr => {
        const metric = pr.metrics?.find((m: any) => m.name === metricName);
        return metric?.value || 0;
      }).filter(score => score > 0);
      
      return scores.length > 0
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length
        : 0;
    };
    
    // Calculate growth for different areas
    const growthAreas = [
      { name: 'Code Quality', metric: 'codeQuality' },
      { name: 'Documentation', metric: 'documentationQuality' },
      { name: 'PR Description', metric: 'prDescriptionQuality' },
      { name: 'Review Thoroughness', metric: 'reviewThoroughness' },
      { name: 'Test Coverage', metric: 'testCoverage' }
    ];
    
    // Calculate growth percentage for each area
    const growthPercentages = growthAreas.map(area => {
      const recentAvg = getAvgScore(recentHalf, area.metric);
      const olderAvg = getAvgScore(olderHalf, area.metric);
      
      // Avoid division by zero
      if (olderAvg === 0) return { ...area, growth: 0 };
      
      const growthPercent = ((recentAvg - olderAvg) / olderAvg) * 100;
      return { ...area, growth: growthPercent };
    });
    
    // Find the area with the highest growth
    const topGrowth = growthPercentages
      .filter(area => area.growth > 0)
      .sort((a, b) => b.growth - a.growth)[0];
    
    if (!topGrowth) {
      return { topGrowthArea: '', growthPercentage: 0 };
    }
    
    return {
      topGrowthArea: topGrowth.name,
      growthPercentage: Math.round(topGrowth.growth)
    };
  } catch (error) {
    console.error('Error calculating growth area:', error);
    return { topGrowthArea: '', growthPercentage: 0 };
  }
}

/**
 * Get level name based on level number
 * @param level The level number
 * @returns Level name
 */
function getLevelName(level: number): string {
  const levels = [
    'Novice',
    'Apprentice',
    'Coder',
    'Developer',
    'Engineer',
    'Senior Engineer',
    'Architect',
    'Wizard',
    'Guru',
    'Legend'
  ];
  
  // Ensure we don't go out of bounds
  if (level <= 0) return levels[0];
  if (level > levels.length) return `${levels[levels.length - 1]} ${level - levels.length + 1}`;
  
  return levels[level - 1];
}