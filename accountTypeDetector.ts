import { AccountType } from '@/models/types';
import { prisma } from '@/utils/prisma';

/**
 * Detect the type of a GitHub account
 * @param installation The installation data from GitHub
 * @returns The account type (ORGANIZATION or PERSONAL)
 */
export async function detectAccountType(installation: any): Promise<AccountType> {
  // Check if it's an organization or user account
  if (installation.account) {
    const accountType = installation.account.type === 'Organization' 
      ? AccountType.ORGANIZATION 
      : AccountType.PERSONAL;
      
    console.log(`Detected account type: ${accountType} for ${installation.account.login}`);
    return accountType;
  }
  
  // Default to organization if we can't detect
  return AccountType.ORGANIZATION;
}

/**
 * Ensure the account exists in our database
 * @param accountId GitHub account ID
 * @param accountName Account name/login
 * @param installationId GitHub installation ID
 * @param accountType Type of account
 * @returns The account data
 */
export async function ensureAccountExists(
  accountId: string,
  accountName: string,
  installationId: string,
  accountType: AccountType
) {
  if (!accountId) {
    console.error('Cannot create account with empty ID');
    throw new Error('Account ID is required');
  }
  
  try {
    // Check if account exists
    const existingAccount = await prisma.account.findUnique({
      where: { id: accountId }
    });
    
    if (existingAccount) {
      // Update installation ID if changed
      if (existingAccount.installationId !== installationId) {
        console.log(`Updating installation ID for account ${accountName}`);
        return await prisma.account.update({
          where: { id: accountId },
          data: { 
            installationId,
            updatedAt: new Date()
          }
        });
      }
      return existingAccount;
    }
    
    // Create new account
    console.log(`Creating new account: ${accountName} (${accountType})`);
    return await prisma.account.create({
      data: {
        id: accountId,
        name: accountName,
        type: accountType === AccountType.ORGANIZATION ? 'ORGANIZATION' : 'PERSONAL',
        installationId,
      }
    });
  } catch (error) {
    console.error(`Error ensuring account exists for ${accountName}:`, error);
    throw error;
  }
} 