import { AccountType, CodeAnalysisResult, CodeFeedback } from '@/models/types';
import OpenAI from 'openai';
import axios from 'axios';
import { prisma } from '@/utils/prisma';
import { getOpenAIKey } from '@/utils/config';



// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize HuggingFace client config
const huggingfaceEndpoint = 'https://api-inference.huggingface.co/models/';
const huggingfaceToken = process.env.HUGGINGFACE_API_KEY;

// Maximum length for text analysis to avoid token limits (512 tokens ≈ 2048 characters)
const MAX_ANALYSIS_LENGTH = 2048;

// IMPORTANT: Define all model endpoints here to ensure consistency
const SENTIMENT_MODEL = 'cardiffnlp/twitter-roberta-base-sentiment-latest';
const TOXICITY_MODEL = 'martin-ha/toxic-comment-model';

// List of legacy model endpoints to avoid using (for error checking)
const LEGACY_MODELS = [
  'distilbert-base-uncased-finetuned-sst-2-english'
];

export interface ComplexityAnalysis {
  technicalComplexity: number;  // 0-1: How complex are the changes technically
  scopeComplexity: number;      // 0-1: How broad is the scope of changes
  riskLevel: number;           // 0-1: Potential impact/risk of changes
  contextNeeded: number;       // 0-1: How much context is needed to review
  testingComplexity: number;   // 0-1: Complexity of testing requirements
  explanation: string;         // AI's explanation of the analysis
}

export interface AnalysisContext {
  files: {
    path: string;
    diff: string;
    previousContent?: string;
  }[];
  description?: string;
  comments?: string[];
  reviews?: string[];
}

/**
 * Analyze code patterns in files
 * @param files Files changed in the PR
 * @param accountType Type of account (ORGANIZATION or PERSONAL)
 * @returns Analysis results
 */
export async function analyzeCode(files: any[], accountType: AccountType): Promise<CodeAnalysisResult> {
  try {
    console.log(`analyzeCode called with ${files.length} files for account type: ${accountType}`);
    
    // Log each filename for debugging
    files.forEach((file, index) => {
      console.log(`File ${index + 1}: ${file.filename}, additions: ${file.additions}, deletions: ${file.deletions}`);
    });
    
    // Log the request for billing/monitoring
    await logAIRequest('openai', 'code_analysis', calculateInputSize(files));
    
    // Filter out non-code files
    const codeFiles = files.filter(file => isCodeFile(file.filename));
    console.log(`After filtering: ${codeFiles.length} code files to analyze`);
    
    // Skip analysis if no code files
    if (codeFiles.length === 0) {
      console.log('No code files to analyze, skipping OpenAI call');
      return {
        feedback: [],
        score: 100,
      };
    }
    
    // For personal accounts, use a more focused and lighter analysis
    const analysisPrompt = accountType === AccountType.PERSONAL
      ? generatePersonalAnalysisPrompt(codeFiles)
      : generateOrganizationAnalysisPrompt(codeFiles);
    
    console.log(`Generated analysis prompt (${analysisPrompt.length} chars), calling OpenAI API with model: gpt-4o-mini-2024-07-18`);
    
    // Use OpenAI for code pattern detection
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18", // Switched to gpt-4o-mini for better quota limits and cost efficiency
      messages: [
        { role: "system", content: "You are a code review assistant that provides constructive feedback on code patterns and quality. Return your analysis as a JSON array of feedback items." },
        { role: "user", content: analysisPrompt }
      ],
      max_tokens: 1000,
      temperature: 0.3,
      response_format: { type: "json_object" }, // Enforce JSON format
    });
    
    console.log(`Received OpenAI response, tokens used: ${response.usage?.total_tokens || 'unknown'}`);
    
    // Parse the response
    const analysis = parseAIResponse(response.choices[0].message?.content || '');
    console.log(`Parsed analysis with ${analysis.feedback.length} feedback items and score: ${analysis.score}`);
    
    // Analyze sentiment if there are comments (for organizations only)
    if (accountType === AccountType.ORGANIZATION) {
      analysis.sentimentScore = await analyzeSentiment(files);
    }
    
    return analysis;
  } catch (error) {
    console.error('Error analyzing code:', error);
    
    // Return empty analysis on error
    return {
      feedback: [
        {
          type: 'error',
          message: 'Failed to analyze code patterns. Please try again later.',
          codeContext: null,
          fileLocation: null
        }
      ],
      score: 0,
    };
  }
}

/**
 * Analyze sentiment of comments
 * @param files Files with potential comments
 * @returns Sentiment score
 */
async function analyzeSentiment(files: any[]): Promise<number> {
  try {
    // Extract comments from code
    const comments = extractComments(files);
    
    if (comments.length === 0) {
      return 0.5; // Return neutral score for no comments
    }
    
    // Log the request for billing/monitoring
    await logAIRequest('huggingface', 'sentiment_analysis', calculateStringSize(comments.join(' ')));
    
    // Safety check to verify we're not using a legacy model endpoint
    if (LEGACY_MODELS.some(model => `${huggingfaceEndpoint}${model}`.includes('distilbert-base-uncased-finetuned-sst-2-english'))) {
      console.warn('Attempt to use legacy model detected - falling back to backup analysis');
      // Fall back to local sentiment analysis instead of throwing error
      return fallbackAnalyzeSentiment(comments.join('\n'));
    }
    
    // Chunk the comments if they exceed token limits
    const commentText = comments.join('\n');
    const chunks = chunkText(commentText, MAX_ANALYSIS_LENGTH);
    let totalScore = 0;
    let validChunks = 0;
    
    console.log(`Analyzing sentiment of ${chunks.length} text chunks using model: ${SENTIMENT_MODEL}`);
    
    // Process each chunk and average the results
    for (const chunk of chunks) {
      try {
        // Use HuggingFace for sentiment analysis with explicit model name
        const response = await axios.post(
          `${huggingfaceEndpoint}${SENTIMENT_MODEL}`,
          { inputs: chunk },
          {
            headers: {
              'Authorization': `Bearer ${huggingfaceToken}`,
              'Content-Type': 'application/json',
            },
            timeout: 10000, // Increase timeout for reliability
          }
        );
        
        // Parse the sentiment scores - updated for the model's output format
        if (Array.isArray(response.data) && response.data.length > 0) {
          const scores = response.data[0];
          // New model returns scores for negative (0), neutral (1), and positive (2)
          const positiveScore = scores.find((s: any) => s.label === '2')?.score || 0;
          const neutralScore = scores.find((s: any) => s.label === '1')?.score || 0;
          
          // Calculate weighted score (0-1 range)
          const weightedScore = positiveScore + (neutralScore * 0.5);
          totalScore += weightedScore;
          validChunks++;
        }
      } catch (chunkError: any) {
        console.warn(`Error analyzing sentiment chunk: ${chunkError?.message || 'Unknown error'}`);
        // Continue with other chunks on error
      }
    }
    
    if (validChunks > 0) {
      return totalScore / validChunks;
    }
    
    // Fall back to simpler analysis if all API calls failed
    return fallbackAnalyzeSentiment(commentText);
  } catch (error) {
    console.error('Error analyzing sentiment:', error);
    return 0.5; // Neutral sentiment on error
  }
}

/**
 * Basic fallback sentiment analysis when API calls fail
 * @param text Text to analyze
 * @returns Sentiment score between 0 and 1
 */
function fallbackAnalyzeSentiment(text: string): number {
  if (!text || !text.trim()) return 0.5;
  
  const lowerText = text.toLowerCase();
  
  // Simple word lists for basic sentiment detection
  const positiveWords = [
    'good', 'great', 'awesome', 'excellent', 'amazing', 'love', 'nice', 'best',
    'better', 'fantastic', 'perfect', 'wonderful', 'happy', 'glad', 'positive',
    'thanks', 'thank', 'appreciate', 'helpful', 'impressive', 'well', 'like'
  ];
  
  const negativeWords = [
    'bad', 'terrible', 'awful', 'horrible', 'hate', 'dislike', 'worst',
    'poor', 'annoying', 'disappointing', 'negative', 'useless', 'sorry',
    'problem', 'issue', 'fail', 'failed', 'failing', 'sucks', 'wrong'
  ];
  
  // Count positive and negative words
  const positiveCount = positiveWords.reduce(
    (count, word) => count + (lowerText.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length, 
    0
  );
  
  const negativeCount = negativeWords.reduce(
    (count, word) => count + (lowerText.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length,
    0
  );
  
  // Handle edge case of no matches
  if (positiveCount === 0 && negativeCount === 0) {
    return 0.5; // Neutral when no sentiment words found
  }
  
  // Calculate sentiment score - scale between 0 and 1
  const total = positiveCount + negativeCount;
  return positiveCount / total;
}

/**
 * Split text into chunks of manageable size for the API
 * @param text Text to split
 * @param maxLength Maximum length per chunk
 * @returns Array of text chunks
 */
function chunkText(text: string, maxLength: number): string[] {
  if (!text || text.length <= maxLength) {
    return [text];
  }
  
  const chunks: string[] = [];
  let remainingText = text;
  
  while (remainingText.length > 0) {
    if (remainingText.length <= maxLength) {
      chunks.push(remainingText);
      break;
    }
    
    // Try to find a clean breaking point (newline or space)
    let cutPoint = remainingText.lastIndexOf('\n', maxLength);
    if (cutPoint === -1 || cutPoint < maxLength / 2) {
      cutPoint = remainingText.lastIndexOf(' ', maxLength);
    }
    if (cutPoint === -1 || cutPoint < maxLength / 2) {
      cutPoint = maxLength;
    }
    
    chunks.push(remainingText.substring(0, cutPoint));
    remainingText = remainingText.substring(cutPoint).trim();
    
    // Safety check to prevent infinite loops
    if (chunks.length > 100) {
      console.warn('Too many chunks created when splitting text, truncating');
      break;
    }
  }
  
  return chunks;
}

/**
 * Generate analysis prompt for personal accounts
 * @param files Code files to analyze
 * @returns Prompt for AI
 */
function generatePersonalAnalysisPrompt(files: any[]): string {
  // Sample up to 3 files for analysis (reduced from 5)
  const sampled = files.slice(0, 3);
  
  let prompt = `Please analyze the following code for quality and provide constructive feedback. Focus on:
1. Code structure and organization
2. Potential bugs or issues
3. Simple improvements
4. Best practices

Files:\n\n`;

  for (const file of sampled) {
    prompt += `Filename: ${file.filename}\n`;
    prompt += `Changes: Added ${file.additions} lines, removed ${file.deletions} lines\n`;
    
    // Limit patch size to avoid context length issues
    const maxPatchLength = 800;
    const patch = file.patch || 'No patch available';
    const truncatedPatch = patch.length > maxPatchLength
      ? patch.substring(0, maxPatchLength) + `\n... (truncated, ${patch.length - maxPatchLength} more characters)`
      : patch;
    
    prompt += `Patch:\n${truncatedPatch}\n\n`;
  }
  
  prompt += `Provide your feedback in the following format:
[
  {
    "type": "suggestion" | "highlight" | "warning",
    "message": "Your feedback message",
    "codeContext": "The code snippet this applies to",
    "fileLocation": "filename:line_number"
  }
]`;

  return prompt;
}

/**
 * Generate analysis prompt for organization accounts
 * @param files Code files to analyze
 * @returns Prompt for AI
 */
function generateOrganizationAnalysisPrompt(files: any[]): string {
  // Sample up to 5 files for analysis (reduced from 10)
  const sampled = files.slice(0, 5);
  
  let prompt = `Please analyze the following code for quality, patterns and team collaboration indicators. Focus on:
1. Code structure and organization
2. Architectural patterns
3. Potential bugs or issues
4. Team collaboration signs
5. Documentation quality
6. Testing approach
7. Best practices

Files:\n\n`;

  for (const file of sampled) {
    prompt += `Filename: ${file.filename}\n`;
    prompt += `Changes: Added ${file.additions} lines, removed ${file.deletions} lines\n`;
    
    // Limit patch size to avoid context length issues
    const maxPatchLength = 800;
    const patch = file.patch || 'No patch available';
    const truncatedPatch = patch.length > maxPatchLength
      ? patch.substring(0, maxPatchLength) + `\n... (truncated, ${patch.length - maxPatchLength} more characters)`
      : patch;
    
    prompt += `Patch:\n${truncatedPatch}\n\n`;
  }
  
  prompt += `Provide your feedback in the following format:
[
  {
    "type": "suggestion" | "highlight" | "warning",
    "message": "Your feedback message",
    "codeContext": "The code snippet this applies to",
    "fileLocation": "filename:line_number"
  }
]`;

  return prompt;
}

/**
 * Parse AI response into structured feedback
 * @param response Response from AI
 * @returns Structured feedback
 */
function parseAIResponse(response: string): CodeAnalysisResult {
  try {
    // First, try to parse the response directly as JSON
    try {
      const directJson = JSON.parse(response) as CodeFeedback[];
      if (Array.isArray(directJson)) {
        return {
          feedback: directJson,
          score: calculateScoreFromFeedback(directJson),
        };
      }
    } catch (directParseError) {
      // If direct parsing fails, continue with other methods
      console.log('Direct JSON parsing failed, trying alternative methods');
    }
    
    // Try to extract JSON array from response using regex
    const match = response.match(/\[\s*{[\s\S]*}\s*\]/);
    
    if (match) {
      const feedbackJson = JSON.parse(match[0]) as CodeFeedback[];
      return {
        feedback: feedbackJson,
        score: calculateScoreFromFeedback(feedbackJson),
      };
    }
    
    // Try to extract JSON from markdown code blocks
    const markdownMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
      try {
        const markdownJson = JSON.parse(markdownMatch[1]) as CodeFeedback[];
        if (Array.isArray(markdownJson)) {
          return {
            feedback: markdownJson,
            score: calculateScoreFromFeedback(markdownJson),
          };
        }
      } catch (markdownParseError) {
        console.error('Error parsing markdown JSON:', markdownParseError);
      }
    }
    
    // Fallback: create simple feedback item
    return {
      feedback: [
        {
          type: 'suggestion',
          message: response.slice(0, 500), // Truncate long responses
          codeContext: null,
          fileLocation: null
        }
      ],
      score: 70, // Default neutral score
    };
  } catch (error) {
    console.error('Error parsing AI response:', error);
    
    return {
      feedback: [
        {
          type: 'suggestion',
          message: 'AI generated feedback could not be parsed correctly.',
          codeContext: null,
          fileLocation: null
        }
      ],
      score: 50, // Default neutral score
    };
  }
}

/**
 * Calculate a score based on feedback items
 * @param feedback Array of feedback items
 * @returns Numerical score (0-100)
 */
function calculateScoreFromFeedback(feedback: CodeFeedback[]): number {
  if (!feedback || feedback.length === 0) {
    return 100; // Perfect score if no feedback
  }
  
  // Count feedback by type
  const counts = {
    highlight: 0,
    suggestion: 0,
    warning: 0,
  };
  
  feedback.forEach(item => {
    if (counts[item.type as keyof typeof counts] !== undefined) {
      counts[item.type as keyof typeof counts]++;
    }
  });
  
  // Calculate score
  // Highlights: +5 each (positive feedback)
  // Suggestions: -2 each (minor issues)
  // Warnings: -5 each (more serious issues)
  let score = 80; // Start with a base score
  score += counts.highlight * 5;
  score -= counts.suggestion * 2;
  score -= counts.warning * 5;
  
  // Ensure score is within 0-100 range
  return Math.max(0, Math.min(100, score));
}

/**
 * Extract comments from code files
 * @param files Files to extract comments from
 * @returns Array of comment strings
 */
function extractComments(files: any[]): string[] {
  const comments: string[] = [];
  
  for (const file of files) {
    if (!file.patch) continue;
    
    // Simple regex-based comment extraction
    // This is a simplification - a real implementation would need to be language-specific
    const singleLineComments = file.patch.match(/\/\/.*$/gm) || [];
    const multiLineComments = file.patch.match(/\/\*[\s\S]*?\*\//gm) || [];
    
    comments.push(...singleLineComments, ...multiLineComments);
  }
  
  return comments;
}

/**
 * Check if a file is a code file
 * @param filename Filename to check
 * @returns True if file is code
 */
function isCodeFile(filename: string): boolean {
  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.java', '.c', '.cpp', '.cs',
    '.go', '.rs', '.php', '.swift', '.kt', '.scala', '.sh', '.bash', '.html',
    '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
    // Add more extensions to include in the analysis
    '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.txt', '.sql',
    '.prisma', '.graphql', '.env', '.toml', '.ini', '.config'
  ];
  
  // Log the filename and whether it's considered a code file for debugging
  console.log(`Checking file: ${filename}, is code file: ${codeExtensions.some(ext => filename.toLowerCase().endsWith(ext))}`);
  
  return codeExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

/**
 * Log an AI API request for monitoring/billing
 * @param serviceType AI service type (openai, huggingface)
 * @param operation Operation being performed
 * @param inputSize Size of input in characters
 */
async function logAIRequest(
  serviceType: string,
  operation: string,
  inputSize: number
): Promise<void> {
  // This would insert a record into AIRequestLog table in production
  // For now, we'll just log to console
  console.log(`AI Request: ${serviceType}, ${operation}, size: ${inputSize}`);
}

/**
 * Calculate input size for files
 * @param files Files to calculate size for
 * @returns Size in characters
 */
function calculateInputSize(files: any[]): number {
  return files.reduce((total, file) => {
    return total + (file.patch ? file.patch.length : 0);
  }, 0);
}

/**
 * Calculate string size
 * @param text Text to calculate size for
 * @returns Size in characters
 */
function calculateStringSize(text: string): number {
  return text.length;
}

/**
 * Generate personalized action items for a developer
 */
export async function generateActionItems(userId: string, pr: any, metrics: any) {
  try {
    console.log(`[AI] Generating action items for user ${userId}`);
    
    // Get historical metrics data
    const historicalMetrics = await prisma.pRMetric.findMany({
      where: {
        pullRequest: {
          authorId: userId
        }
      },
      take: 30, // Reduced from 50 to limit context size
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        pullRequest: true
      }
    });
    
    // Get recent PRs for pattern analysis
    const recentPRs = await prisma.pullRequest.findMany({
      where: {
        authorId: userId
      },
      take: 5, // Reduced from 10 to limit context size
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        metrics: true
      }
    });
    
    // Get user profile
    const userProfile = await prisma.userProfile.findUnique({
      where: {
        userId: userId
      }
    });
    
    // Organize metrics by category and name
    const organizedMetrics = organizeMetricsByCategory(metrics);
    const historicalMetricsOrganized = organizeHistoricalMetrics(historicalMetrics);
    
    // Extract PR content for better context
    const prContent = {
      id: pr.id,
      title: pr.title || '',
      description: pr.description || '',
      number: pr.number,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      files: (pr.files || []).map((file: any) => ({
        filename: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        status: file.status
      })).slice(0, 5), // Limit to 5 files (reduced from 10) to avoid context overflow
      labels: (pr.labels || []).map((label: any) => label.name),
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt
    };
    
    // Create context for OpenAI with enhanced PR information
    const context = {
      currentPR: prContent,
      currentMetrics: organizedMetrics,
      historicalMetrics: historicalMetricsOrganized,
      recentPRs: recentPRs.map(recentPr => ({
        id: recentPr.id,
        title: recentPr.title,
        createdAt: recentPr.createdAt,
        efficiencyScore: recentPr.efficiencyScore,
        wellnessScore: recentPr.wellnessScore,
        qualityScore: recentPr.qualityScore,
        overallScore: recentPr.overallScore
      })),
      userProfile: {
        primaryPersona: userProfile?.primaryPersona || 'Unknown',
        secondaryPersona: userProfile?.secondaryPersona || 'Unknown',
        expertiseAreas: userProfile?.expertiseAreas || [],
      }
    };
    
    // Call OpenAI to generate action items
    const actionItems = await callOpenAIForActionItems(context);
    console.log(`[AI] Generated ${actionItems.actionItems.length} action items for user ${userId}`);
    
    return actionItems;
  } catch (error) {
    console.error('[AI] Error generating action items:', error);
    
    // Return default action items on error
    return {
      overallRecommendation: "Consider optimizing your PR size and maintaining regular breaks to improve both efficiency and wellness.",
      actionItems: [
        {
          title: "Optimize PR Size",
          description: "Try to keep PRs under 300 lines of code for more effective reviews and quicker iteration.",
          category: "efficiency",
          potentialImpact: 8
        },
        {
          title: "Maintain Regular Breaks",
          description: "Consider the Pomodoro technique (25 min work, 5 min break) to maintain focus and prevent burnout.",
          category: "wellness",
          potentialImpact: 7
        },
        {
          title: "Increase Test Coverage",
          description: "Add tests for core functionality to improve code quality and reduce future bugs.",
          category: "quality",
          potentialImpact: 6
        }
      ]
    };
  }
}

/**
 * Call OpenAI to generate action items
 */
async function callOpenAIForActionItems(context: any) {
  const systemMessage = `You are an expert software development coach that analyzes a developer's metrics and provides specific, actionable advice to help them improve. Your goal is to provide 3-5 personalized action items based on the metrics data, current PR context, and user's work patterns. Focus on being specific, concrete, and actionable.

IMPORTANT: You will be provided with detailed information about the current PR being analyzed. Use this information to make your recommendations highly relevant to what the developer is currently working on.

Each action item should:
1. Be directly tied to a specific metric or pattern in their data
2. Relate to the current PR's content whenever possible
3. Include a clear recommended action they can take
4. Explain the expected impact
5. Be tailored to their persona type and expertise areas
6. Be categorized as efficiency, wellness, quality, or work type balance

When analyzing the current PR:
- Look at the PR title, description, and files changed
- Consider the type of work (feature, bug fix, refactoring, etc.)
- Note the size and complexity of changes
- Check if there are any patterns that could be improved

When analyzing work type balance, consider:
- Is there a healthy balance between feature work and maintenance?
- Is the developer doing too much reactive work and not enough proactive work?
- How does their current work balance compare to historical patterns?
- Does the current PR fit their typical pattern or is it different?

Provide your response in JSON format with the following structure:
{
  "overallRecommendation": "A sentence summarizing the key areas to focus on",
  "actionItems": [
    {
      "title": "Action item title",
      "description": "Detailed description of the action that references the current PR",
      "category": "efficiency|wellness|quality|work_type",
      "potentialImpact": 1-10
    }
  ]
}`;

  const userMessage = `Please analyze this developer's metrics and provide personalized action items for improvement:
${JSON.stringify(context, null, 2)}`;

  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || '',
    });
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18", // Switched to gpt-4o-mini for better quota limits and cost efficiency
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ],
      temperature: 0.5, // Reduced from 0.7 for more consistent outputs
      response_format: { type: "json_object" }, // Enforce JSON format
    });
    
    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }
    
    try {
      // Clean the response to ensure it's valid JSON
      let cleanedContent = content;
      
      // Find JSON content if it's wrapped in markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        cleanedContent = jsonMatch[1];
      }
      
      // Ensure the content starts with { and ends with }
      cleanedContent = cleanedContent.trim();
      if (!cleanedContent.startsWith('{') || !cleanedContent.endsWith('}')) {
        // Try to extract JSON object
        const jsonObjectMatch = cleanedContent.match(/{[\s\S]*}/);
        if (jsonObjectMatch) {
          cleanedContent = jsonObjectMatch[0];
        }
      }
      
      // Parse the JSON response with better error handling
      const result = JSON.parse(cleanedContent);
      
      // Validate response structure
      if (!result.overallRecommendation || !Array.isArray(result.actionItems)) {
        console.error('Invalid response format from OpenAI:', content);
        throw new Error('Invalid response format from OpenAI');
      }
      
      return {
        overallRecommendation: result.overallRecommendation,
        actionItems: result.actionItems
      };
    } catch (parseError) {
      console.error('Error parsing OpenAI JSON response:', parseError);
      console.error('Raw response:', content);
      throw new Error('Failed to parse OpenAI response as JSON');
    }
  } catch (error) {
    console.error('Error calling OpenAI:', error);
    throw error;
  }
}

/**
 * Organize metrics by category and name for easier analysis
 */
function organizeMetricsByCategory(metrics: any) {
  const result: Record<string, Record<string, number>> = {};
  
  for (const category in metrics) {
    result[category] = {};
    for (const name in metrics[category]) {
      result[category][name] = metrics[category][name];
    }
  }
  
  return result;
}

/**
 * Organize historical metrics for trend analysis
 */
function organizeHistoricalMetrics(metrics: any[]) {
  const result: Record<string, Record<string, any[]>> = {
    efficiency: {},
    wellness: {},
    quality: {}
  };
  
  metrics.forEach(metric => {
    const category = metric.category;
    const name = metric.name;
    
    if (!result[category]) {
      result[category] = {};
    }
    
    if (!result[category][name]) {
      result[category][name] = [];
    }
    
    result[category][name].push({
      value: metric.value,
      date: metric.pullRequest.createdAt
    });
  });
  
  return result;
}

/**
 * Analyze code complexity using AI
 */
export async function analyzeCodeComplexity(context: AnalysisContext): Promise<ComplexityAnalysis> {
  try {
    const openai = new OpenAI({
      apiKey: getOpenAIKey()
    });

    // Prepare the prompt
    const prompt = generateAnalysisPrompt(context);

    // Get AI analysis - use gpt-4-turbo for larger context window
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      messages: [
        {
          role: "system",
          content: `You are an expert code reviewer and technical architect. Analyze the provided code changes and context to determine their complexity across multiple dimensions. Score each dimension from 0 to 1, where 0 is simplest and 1 is most complex. Provide your analysis in JSON format with the following structure:
{
  "technicalComplexity": number,
  "scopeComplexity": number,
  "riskLevel": number,
  "contextNeeded": number,
  "testingComplexity": number,
  "explanation": string
}

Return only valid JSON in your response.`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    // Parse the response
    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    let analysis;
    try {
      // Preprocess the content to handle markdown-formatted JSON
      let processedContent = content;
      
      // Remove markdown code block formatting if present
      const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch) {
        processedContent = jsonBlockMatch[1];
      }
      
      // Try to parse the processed content
      analysis = JSON.parse(processedContent);
    } catch (parseError) {
      console.error('Error parsing OpenAI response:', parseError);
      console.error('Raw response:', content);
      throw new Error('Failed to parse OpenAI response as JSON');
    }

    // Validate and normalize scores
    return {
      technicalComplexity: normalizeScore(analysis.technicalComplexity),
      scopeComplexity: normalizeScore(analysis.scopeComplexity),
      riskLevel: normalizeScore(analysis.riskLevel),
      contextNeeded: normalizeScore(analysis.contextNeeded),
      testingComplexity: normalizeScore(analysis.testingComplexity),
      explanation: analysis.explanation || "No explanation provided"
    };
  } catch (error) {
    console.error('Error in AI complexity analysis:', error);
    // Return default values on error
    return {
      technicalComplexity: 0.5,
      scopeComplexity: 0.5,
      riskLevel: 0.5,
      contextNeeded: 0.5,
      testingComplexity: 0.5,
      explanation: "Error occurred during analysis"
    };
  }
}

/**
 * Generate the analysis prompt from the context
 */
function generateAnalysisPrompt(context: AnalysisContext): string {
  let prompt = `Please analyze the following code changes:\n\n`;

  // Limit the number of files to analyze to prevent context length issues
  const filesToAnalyze = context.files.slice(0, 3); // Limit to 3 files (reduced from 5)
  
  prompt += `Analyzing ${filesToAnalyze.length} of ${context.files.length} files\n\n`;

  // Add file changes with truncation for large diffs
  filesToAnalyze.forEach(file => {
    prompt += `File: ${file.path}\n`;
    
    // Truncate large diffs to prevent context length issues
    const maxDiffLength = 800; // Reduced from 1000
    const truncatedDiff = file.diff.length > maxDiffLength
      ? file.diff.substring(0, maxDiffLength) + `\n... (truncated, ${file.diff.length - maxDiffLength} more characters)`
      : file.diff;
    
    prompt += `Diff:\n${truncatedDiff}\n\n`;
    
    // Only include previous content for very small files and only if absolutely necessary
    if (file.previousContent && file.previousContent.length < 500) {
      prompt += `Previous content (truncated):\n${file.previousContent.substring(0, 500)}\n\n`;
    }
  });

  // Add PR description if available (truncated if too long)
  if (context.description) {
    const maxDescriptionLength = 500;
    const truncatedDescription = context.description.length > maxDescriptionLength
      ? context.description.substring(0, maxDescriptionLength) + `... (truncated)`
      : context.description;
    
    prompt += `Pull Request Description:\n${truncatedDescription}\n\n`;
  }

  // Add a limited number of review comments if available
  if (context.comments?.length) {
    const maxComments = 5; // Limit to 5 comments
    const truncatedComments = context.comments.slice(0, maxComments);
    
    prompt += `Review Comments (${truncatedComments.length} of ${context.comments.length}):\n${truncatedComments.join('\n')}\n\n`;
    
    if (context.comments.length > maxComments) {
      prompt += `... (${context.comments.length - maxComments} more comments not shown)\n\n`;
    }
  }

  // Add a limited number of reviews if available
  if (context.reviews?.length) {
    const maxReviews = 3; // Limit to 3 reviews
    const truncatedReviews = context.reviews.slice(0, maxReviews);
    
    prompt += `Reviews (${truncatedReviews.length} of ${context.reviews.length}):\n${truncatedReviews.join('\n')}\n\n`;
    
    if (context.reviews.length > maxReviews) {
      prompt += `... (${context.reviews.length - maxReviews} more reviews not shown)\n\n`;
    }
  }

  // Final safeguard: ensure the total prompt doesn't exceed a certain length
  const maxPromptLength = 4000; // Reduced from 6000 to stay well under the 8192 token limit
  if (prompt.length > maxPromptLength) {
    prompt = prompt.substring(0, maxPromptLength) +
      `\n\n... (prompt truncated to prevent exceeding token limits)\n\n`;
  }

  prompt += `
Please analyze the complexity of these changes across the following dimensions:

1. Technical Complexity (0-1):
   - How complex are the changes technically?
   - Consider algorithms, data structures, architectural changes

2. Scope Complexity (0-1):
   - How broad is the scope of changes?
   - Consider number of files, components affected

3. Risk Level (0-1):
   - What's the potential impact/risk of these changes?
   - Consider critical paths, security implications

4. Context Needed (0-1):
   - How much context is needed to review?
   - Consider dependencies, domain knowledge required

5. Testing Complexity (0-1):
   - How complex are the testing requirements?
   - Consider test coverage needs, edge cases

Provide your analysis in JSON format with scores and explanation.`;

  return prompt;
}

/**
 * Normalize a score to ensure it's between 0 and 1
 */
function normalizeScore(score: number): number {
  if (typeof score !== 'number' || isNaN(score)) return 0.5;
  return Math.max(0, Math.min(1, score));
} 