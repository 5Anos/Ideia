import { ensureConnectedOperationalSpreadsheet } from './tenantConnectionManager.ts';
import { initControlPlaneRegistry } from './tenantRegistry.ts';
import { AgentsRepository } from './repositories/agentsRepository.ts';
import { ApprovalsRepository } from './repositories/approvalsRepository.ts';
import { AuditRepository } from './repositories/auditRepository.ts';
import { PoliciesRepository } from './repositories/policiesRepository.ts';
import { UsersAndSettingsRepository } from './repositories/usersRepository.ts';
import { WorkflowsRepository } from './repositories/workflowsRepository.ts';

export interface TenantDatabaseContext {
  companyId: string;
  agents: AgentsRepository;
  policies: PoliciesRepository;
  approvals: ApprovalsRepository;
  workflows: WorkflowsRepository;
  audit: AuditRepository;
  settings: UsersAndSettingsRepository;
}

export function initDatabasePlatform(): void {
  initControlPlaneRegistry();
}

/**
 * Resolve o acesso à base de dados operacional EXCLUSIVAMENTE para a empresa autenticada.
 * Lança TenantDatabaseNotConnectedError caso a empresa não tenha folha Google Sheets ligada e validada.
 */
export async function getTenantDatabase(companyId: string): Promise<TenantDatabaseContext> {
  await ensureConnectedOperationalSpreadsheet(companyId);

  return {
    companyId,
    agents: new AgentsRepository(companyId),
    policies: new PoliciesRepository(companyId),
    approvals: new ApprovalsRepository(companyId),
    workflows: new WorkflowsRepository(companyId),
    audit: new AuditRepository(companyId),
    settings: new UsersAndSettingsRepository(companyId),
  };
}

export {
  setGoogleApiTransport,
  setGoogleRetryBaseDelayForTests,
  GoogleSheetsError,
  extractSpreadsheetIdFromInput,
  type GoogleApiTransport,
} from './googleSheetsProvider.ts';
export {
  TenantDatabaseNotConnectedError,
  clearAllTenantCachesForTests,
  invalidateTenantCache,
  startCompanyGoogleOAuthFlow,
  completeOAuthCodeCallback,
  completeOAuthBridgeLogin,
  listAvailableSpreadsheetsForTenant,
  selectExistingSpreadsheetForTenant,
  createNewSpreadsheetForTenant,
  testTenantSheetsConnection,
  disconnectTenantGoogleAccount,
  buildTenantSheetsConfigResponse,
  isOAuthCodeFlowConfigured,
} from './tenantConnectionManager.ts';
export { initializeCompanySpreadsheetBaseline } from './demoSpreadsheetSeed.ts';
export { resetRegistryCacheForTests } from './tenantRegistry.ts';
