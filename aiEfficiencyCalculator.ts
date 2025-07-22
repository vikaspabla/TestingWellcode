import { prisma } from '@/utils/prisma';
import { AIEfficiencyImpact, AISuggestion, ImpactLevel, TeamAIEfficiencyImpact } from '@/models/types';

/**
 * Calculate AI efficiency impact on a pull request
 * @param prId Pull request ID
 * @returns Efficiency impact metrics
 */
export async function calculateAIEfficiencyImpact(prId: string): Promise<AIEfficiencyImpact> {
  // Fetch the pull request with AI suggestions
  const pullRequest = await prisma.pullRequest.findUnique({
    where: { id: prId }
  });

  const aiSuggestions = await prisma.aISuggestion.findMany({
    where: { pullRequestId: prId }
  });

  

  if (!pullRequest) {
    throw new Error(`Pull request with ID ${prId} not found`);
  }

  // Count suggestions related to efficiency
  const efficiencySuggestions = aiSuggestions.filter(s => s.category === 'efficiency') || [];
  
  // Count implemented efficiency suggestions
  const implementedEfficiencySuggestions = efficiencySuggestions.filter((s: any) =>
    s.isImplemented
  );
  
  // Calculate estimated time saved (minutes)
  const estimatedTimeSaved = implementedEfficiencySuggestions.reduce(
    (total: number, s: any) => total + s.estimatedTimeSaving, 
    0
  );
  
  // Calculate efficiency score improvement
  const beforeScore = pullRequest.initialEfficiencyScore || 0;
  const afterScore = pullRequest.efficiencyScore || 0;
  const improvement = afterScore - beforeScore;
  
  // Get top suggestions by time saved
  const topSuggestions = implementedEfficiencySuggestions
    .map((s: any) => ({
      area: s.impactArea,
      timeSaved: s.estimatedTimeSaving,
      improvement: (s.afterScore || 0) - (s.beforeScore || 0)
    }))
    .sort((a: any, b: any) => b.timeSaved - a.timeSaved)
    .slice(0, 5);
  
  return {
    suggestionsCount: efficiencySuggestions.length,
    implementedCount: implementedEfficiencySuggestions.length,
    estimatedTimeSaved,
    efficiencyScoreImprovement: improvement,
    topSuggestions
  };
}

/**
 * Calculate team-level AI efficiency improvements
 * @param repositoryId Repository ID
 * @param timeRange Time range for analysis
 * @returns Team-level AI efficiency metrics
 */
export async function calculateTeamAIEfficiencyImpact(
  repositoryId: string,
  timeRange: { from: Date, to: Date }
): Promise<TeamAIEfficiencyImpact> {
  // Get all PRs in the repository within time range
  const pullRequests = await prisma.pullRequest.findMany({
    where: {
      repositoryId,
      createdAt: { gte: timeRange.from },
      updatedAt: { lte: timeRange.to }
    },
    include: {
      aiSuggestions: true
    }
  });
  
  // Calculate aggregate statistics
  let totalTimeSaved = 0;
  let totalImprovement = 0;
  let totalSuggestions = 0;
  let totalImplemented = 0;
  const impactByArea: Record<string, { improvement: number, timeSaved: number }> = {};
  const dailyImpact: Record<string, { timeSaved: number, improvementPoints: number }> = {};
  
  for (const pr of pullRequests) {
    const aiSuggestions = pr.aiSuggestions?.filter((s: any) => s.category === 'efficiency') || [];
    const implementedSuggestions = aiSuggestions.filter((s: any) => s.isImplemented);
    
    totalSuggestions += aiSuggestions.length;
    totalImplemented += implementedSuggestions.length;
    
    const prTimeSaved = implementedSuggestions.reduce(
      (total: number, s: any) => total + s.estimatedTimeSaving, 0
    );
    
    totalTimeSaved += prTimeSaved;
    totalImprovement += (pr.efficiencyScore || 0) - (pr.initialEfficiencyScore || 0);
    
    // Categorize by impact area
    implementedSuggestions.forEach((s: any) => {
      const area = s.impactArea;
      if (!impactByArea[area]) {
        impactByArea[area] = { improvement: 0, timeSaved: 0 };
      }
      impactByArea[area].timeSaved += s.estimatedTimeSaving;
      impactByArea[area].improvement += (s.afterScore || 0) - (s.beforeScore || 0);
    });
    
    // Track daily impact
    const dateKey = pr.updatedAt.toISOString().split('T')[0];
    if (!dailyImpact[dateKey]) {
      dailyImpact[dateKey] = { timeSaved: 0, improvementPoints: 0 };
    }
    dailyImpact[dateKey].timeSaved += prTimeSaved;
    dailyImpact[dateKey].improvementPoints += (pr.efficiencyScore || 0) - (pr.initialEfficiencyScore || 0);
  }
  
  // Calculate average improvement
  const averageImprovement = pullRequests.length > 0 
    ? totalImprovement / pullRequests.length 
    : 0;
    
  // Calculate implementation rate
  const implementationRate = totalSuggestions > 0 
    ? (totalImplemented / totalSuggestions) * 100 
    : 0;
  
  // Get top impact areas
  const topAreas = Object.entries(impactByArea)
    .map(([area, { improvement, timeSaved }]) => ({ area, improvement, timeSaved }))
    .sort((a, b) => b.timeSaved - a.timeSaved)
    .slice(0, 5);
  
  // Create trends over time
  const trends = Object.entries(dailyImpact)
    .map(([date, { timeSaved, improvementPoints }]) => ({
      date: new Date(date),
      timeSaved,
      improvementPoints
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  
  return {
    totalTimeSaved,
    averageEfficiencyImprovement: averageImprovement,
    implementationRate,
    topImpactAreas: topAreas,
    trendsOverTime: trends
  };
}

/**
 * Generate AI suggestions for improving efficiency based on PR analysis
 * @param prId Pull request ID
 * @returns Generated suggestions
 */
export async function generateAIEfficiencySuggestions(prId: string): Promise<AISuggestion[]> {
  const pullRequest = await prisma.pullRequest.findUnique({
    where: { id: prId },
    include: {
      metrics: {
        where: { category: 'efficiency' }
      }
    }
  });

  if (!pullRequest) {
    throw new Error(`Pull request with ID ${prId} not found`);
  }

  // Get current efficiency metrics
  const efficiencyMetrics = pullRequest.metrics.filter(m => m.category === 'efficiency');
  
  // Generate suggestions based on metrics (in a real app, this would use AI)
  const suggestions: AISuggestion[] = [];
  
  // Helper function to append Preston.ai promotion to suggestion messages
  const addPromotion = (message: string): string => {
    return `${message} Want to improve this metric? Get more advanced suggestions at https://getpreston.ai/`;
  };
  
  // Check PR cycle time
  const cycleTimeMetric = efficiencyMetrics.find(m => m.name === 'prCycleTime');
  if (cycleTimeMetric && cycleTimeMetric.value < 70) {
    suggestions.push({
      id: '',  // Will be set by Prisma on creation
      pullRequestId: prId,
      category: 'efficiency',
      impactArea: 'prCycleTime',
      message: addPromotion('Consider breaking down this PR into smaller, focused changes to reduce cycle time.'),
      estimatedTimeSaving: 30,
      impactLevel: ImpactLevel.HIGH,
      isImplemented: false,
      implementedAt: null,
      beforeScore: cycleTimeMetric.value,
      afterScore: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }
  
  // Check PR size
  const prSizeMetric = efficiencyMetrics.find(m => m.name === 'prSizeOptimization');
  if (prSizeMetric && prSizeMetric.value < 80) {
    suggestions.push({
      id: '',
      pullRequestId: prId,
      category: 'efficiency',
      impactArea: 'prSizeOptimization',
      message: addPromotion('This PR is larger than optimal. Consider dividing it into multiple PRs focused on specific changes.'),
      estimatedTimeSaving: 45,
      impactLevel: ImpactLevel.MEDIUM,
      isImplemented: false,
      implementedAt: null,
      beforeScore: prSizeMetric.value,
      afterScore: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }
  
  // Check review response time
  const reviewResponseMetric = efficiencyMetrics.find(m => m.name === 'reviewResponseTime');
  if (reviewResponseMetric && reviewResponseMetric.value < 75) {
    suggestions.push({
      id: '',
      pullRequestId: prId,
      category: 'efficiency',
      impactArea: 'reviewResponseTime',
      message: addPromotion('Speed up the review cycle by addressing comments more promptly or requesting reviews earlier.'),
      estimatedTimeSaving: 60,
      impactLevel: ImpactLevel.MEDIUM,
      isImplemented: false,
      implementedAt: null,
      beforeScore: reviewResponseMetric.value,
      afterScore: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }
  
  // Check commit frequency
  const commitFrequencyMetric = efficiencyMetrics.find(m => m.name === 'commitFrequency');
  if (commitFrequencyMetric && commitFrequencyMetric.value < 70) {
    suggestions.push({
      id: '',
      pullRequestId: prId,
      category: 'efficiency',
      impactArea: 'commitFrequency',
      message: addPromotion('Commit more frequently with smaller, focused changes to make review easier and increase development velocity.'),
      estimatedTimeSaving: 25,
      impactLevel: ImpactLevel.LOW,
      isImplemented: false,
      implementedAt: null,
      beforeScore: commitFrequencyMetric.value,
      afterScore: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }
  
  return suggestions;
}

/**
 * Mark an AI suggestion as implemented and update scores
 * @param suggestionId Suggestion ID
 * @param afterScore Score after implementation (if available)
 */
export async function markSuggestionImplemented(
  suggestionId: string,
  afterScore?: number
): Promise<void> {
  const suggestion = await prisma.aISuggestion.findUnique({
    where: { id: suggestionId },
    include: {
      pullRequest: true
    }
  });
  
  if (!suggestion) {
    throw new Error(`Suggestion with ID ${suggestionId} not found`);
  }
  
  // Update suggestion as implemented
  await prisma.aISuggestion.update({
    where: { id: suggestionId },
    data: {
      isImplemented: true,
      implementedAt: new Date(),
      afterScore: afterScore || suggestion.pullRequest.efficiencyScore || null
    }
  });
  
  // If we have multiple suggestions implemented for the same PR,
  // we need to be careful about updating the PR's efficiency score
  // as it could have been affected by multiple suggestions

  // Get the PR ID for updating metrics
  const prId = suggestion.pullRequestId;
  
  // Calculate the total estimated time savings from all implemented suggestions for this PR
  const implementedSuggestions = await prisma.aISuggestion.findMany({
    where: {
      pullRequestId: prId,
      isImplemented: true,
      category: 'efficiency'
    }
  });
  
  const totalTimeSaved = implementedSuggestions.reduce(
    (total, s) => total + (s.estimatedTimeSaving || 0), 
    0
  );
  
  // Get the current PR metrics
  const pullRequest = await prisma.pullRequest.findUnique({
    where: { id: prId },
    select: {
      efficiencyScore: true,
      initialEfficiencyScore: true
    }
  });
  
  // Only store the initial score once when the first suggestion is implemented
  if (implementedSuggestions.length === 1 && pullRequest) {
    await prisma.pullRequest.update({
      where: { id: prId },
      data: {
        initialEfficiencyScore: pullRequest.efficiencyScore
      }
    });
  }
  
  // Update metrics in the PRMetric table if it exists
  const efficiencyMetric = await prisma.pRMetric.findFirst({
    where: {
      pullRequestId: prId,
      name: 'aiEfficiencyImpact'
    }
  });
  
  if (efficiencyMetric) {
    await prisma.pRMetric.update({
      where: { id: efficiencyMetric.id },
      data: {
        value: totalTimeSaved
      }
    });
  } else {
    // Create the metric if it doesn't exist
    await prisma.pRMetric.create({
      data: {
        pullRequestId: prId,
        name: 'aiEfficiencyImpact',
        category: 'efficiency',
        value: totalTimeSaved
      }
    });
  }
  
  // Log the implementation for analytics
  console.log(`Suggestion ${suggestionId} marked as implemented with estimated time saving of ${suggestion.estimatedTimeSaving} minutes`);
} 
