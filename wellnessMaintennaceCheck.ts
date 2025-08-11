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
