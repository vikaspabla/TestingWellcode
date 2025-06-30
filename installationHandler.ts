import { PrismaClient } from '@prisma/client';
import { detectAccountType } from './accountTypeDetector';

const prisma = new PrismaClient();

/**
 * Handle a GitHub App installation event
 * @param event The installation event payload
 * @returns The created account
 */
export async function handleInstallationEvent(event: any) {
  const { action } = event;

  switch (action) {
    case 'created':
      return handleNewInstallation(event);
    
    case 'deleted':
      return handleUninstallation(event);
    
    case 'added':
      return handleRepositoriesAdded(event);
    
    case 'removed':
      return handleRepositoriesRemoved(event);
    
    default:
      console.log(`Unhandled installation action: ${action}`);
      return null;
  }
}

/**
 * Handle a new installation of the GitHub App
 * @param event The installation event payload
 * @returns The created account
 */
async function handleNewInstallation(event: any) {
  try {
    // Detect account type
    const accountType = await detectAccountType(event.installation);
    
    // Create account info object from installation data
    const accountInfo = {
      id: event.installation.account.id.toString(),
      name: event.installation.account.login,
      type: accountType,
      installationId: event.installation.id.toString()
    };
    
    // Create account record
    const account = await prisma.account.create({
      data: {
        id: accountInfo.id,
        name: accountInfo.name,
        type: accountInfo.type,
        installationId: accountInfo.installationId
      }
    });
    
    // Initialize repositories
    for (const repo of event.repositories) {
      await prisma.repository.create({
        data: {
          id: repo.id.toString(),
          name: repo.name,
          accountId: account.id,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch || 'main'
        }
      });
    }
    
    // Set up default settings based on account type
    const defaultSettings = accountInfo.type === 'PERSONAL'
      ? getPersonalAccountDefaults()
      : getOrganizationDefaults();
      
    await prisma.account.update({
      where: { id: account.id },
      data: { settings: defaultSettings }
    });
    
    return account;
  } catch (error) {
    console.error('Error handling new installation:', error);
    throw error;
  }
}

/**
 * Handle uninstallation of the GitHub App
 * @param event The installation event payload
 */
async function handleUninstallation(event: any) {
  try {
    const accountId = event.installation.account.id.toString();
    
    // Get current settings and ensure it's an object
    const currentSettings = await getAccountSettings(accountId);
    
    // Mark account as inactive rather than deleting
    // This preserves data for potential reinstalls and analytics
    await prisma.account.update({
      where: { id: accountId },
      data: {
        // We would add an 'active' field to the Account model for this
        // For now, we could use settings to store this information
        settings: {
          ...(currentSettings as Record<string, any>),
          active: false,
          uninstalledAt: new Date().toISOString()
        }
      }
    });
    
    return { success: true, accountId };
  } catch (error) {
    console.error('Error handling uninstallation:', error);
    throw error;
  }
}

/**
 * Handle repositories added to an existing installation
 * @param event The installation event payload
 */
async function handleRepositoriesAdded(event: any) {
  try {
    const accountId = event.installation.account.id.toString();
    
    // Add new repositories
    for (const repo of event.repositories_added) {
      // Check if repository already exists
      const existingRepo = await prisma.repository.findUnique({
        where: { id: repo.id.toString() }
      });
      
      if (!existingRepo) {
        await prisma.repository.create({
          data: {
            id: repo.id.toString(),
            name: repo.name,
            accountId,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch || 'main'
          }
        });
      }
    }
    
    return { success: true, accountId, reposAdded: event.repositories_added.length };
  } catch (error) {
    console.error('Error handling repositories added:', error);
    throw error;
  }
}

/**
 * Handle repositories removed from an existing installation
 * @param event The installation event payload
 */
async function handleRepositoriesRemoved(event: any) {
  try {
    const accountId = event.installation.account.id.toString();
    
    // Mark repositories as inactive rather than deleting
    for (const repo of event.repositories_removed) {
      await prisma.repository.update({
        where: { id: repo.id.toString() },
        data: {
          // We would add an 'active' field to the Repository model for this
          // For now, we could use settings to store this information
          settings: {
            active: false,
            removedAt: new Date().toISOString()
          }
        }
      });
    }
    
    return { success: true, accountId, reposRemoved: event.repositories_removed.length };
  } catch (error) {
    console.error('Error handling repositories removed:', error);
    throw error;
  }
}

/**
 * Get default settings for a personal account
 * @returns Default settings object
 */
function getPersonalAccountDefaults() {
  return {
    workingHours: {
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
      workDays: [1, 2, 3, 4, 5]
    },
    metricWeights: {
      efficiency: 0.33,
      wellness: 0.33,
      quality: 0.34,
      subCategories: {
        efficiency: {
          prCycleTime: 0.15,
          prSizeOptimization: 0.15,
          reviewResponseTime: 0.10,
          commitFrequency: 0.10,
          wipManagement: 0.10,
          mergeFrequency: 0.10,
          firstResponseTime: 0.10,
          prIterations: 0.10,
          branchAge: 0.05,
          prDependencies: 0.05
        },
        wellness: {
          workHoursPattern: 0.15,
          collaborationBalance: 0.15,
          communicationTone: 0.10,
          breakPatterns: 0.15,
          feedbackReception: 0.10,
          contextSwitching: 0.10,
          workTypeBalance: 0.15,
          proactiveWorkScore: 0.10
        },
        quality: {
          testPresence: 0.25,
          codePatterns: 0.20,
          prDescriptionQuality: 0.10,
          reviewThoroughness: 0.20,
          documentationQuality: 0.15,
          complexityTrends: 0.10
        }
      }
    },
    thresholds: {
      prSize: { min: 50, ideal: 200, max: 400 },
      reviewTime: { target: 48 }, // More lenient for personal accounts
      workHoursWarning: { percentage: 30 } // More lenient for personal accounts
    },
    levelThresholds: [
      { level: 1, name: "Novice", points: 0 },
      { level: 2, name: "Apprentice", points: 100 },
      { level: 3, name: "Coder", points: 200 },
      { level: 4, name: "Developer", points: 300 }
    ]
  };
}

/**
 * Get default settings for an organization account
 * @returns Default settings object
 */
function getOrganizationDefaults() {
  return {
    workingHours: {
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
      workDays: [1, 2, 3, 4, 5]
    },
    metricWeights: {
      efficiency: 0.33,
      wellness: 0.33,
      quality: 0.34,
      subCategories: {
        efficiency: {
          prCycleTime: 0.15,
          prSizeOptimization: 0.15,
          reviewResponseTime: 0.10,
          commitFrequency: 0.10,
          wipManagement: 0.10,
          mergeFrequency: 0.10,
          firstResponseTime: 0.10,
          prIterations: 0.10,
          branchAge: 0.05,
          prDependencies: 0.05
        },
        wellness: {
          workHoursPattern: 0.15,
          collaborationBalance: 0.15,
          communicationTone: 0.10,
          breakPatterns: 0.15,
          feedbackReception: 0.10,
          contextSwitching: 0.10,
          workTypeBalance: 0.15,
          proactiveWorkScore: 0.10
        },
        quality: {
          testPresence: 0.25,
          codePatterns: 0.20,
          prDescriptionQuality: 0.10,
          reviewThoroughness: 0.20,
          documentationQuality: 0.15,
          complexityTrends: 0.10
        }
      }
    },
    thresholds: {
      prSize: { min: 50, ideal: 200, max: 500 },
      reviewTime: { target: 24 }, // Stricter for organizations
      workHoursWarning: { percentage: 20 } // Stricter for organizations
    },
    levelThresholds: [
      { level: 1, name: "Novice", points: 0 },
      { level: 2, name: "Apprentice", points: 100 },
      { level: 3, name: "Coder", points: 200 },
      { level: 4, name: "Developer", points: 300 }
    ],
    teamFeatures: {
      enabled: true,
      dashboards: true,
      leaderboards: true
    }
  };
}

/**
 * Get account settings
 * @param accountId The account ID
 * @returns Current account settings
 */
async function getAccountSettings(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { settings: true }
  });
  
  return account?.settings || {};
} 