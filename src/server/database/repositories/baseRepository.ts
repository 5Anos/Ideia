import {
  columnIndexToLetter,
  serializeRowObject,
  WORKSHEET_HEADERS,
  type WorksheetName,
} from '../sheetSchema.ts';
import {
  appendWorksheetRows,
  batchUpdateValues,
  deleteWorksheetRow,
  updateWorksheetRow,
} from '../googleSheetsProvider.ts';
import {
  invalidateTenantCache,
  loadTenantSpreadsheetTables,
  withTenantWriteLock,
  type SheetRowEntry,
} from '../tenantConnectionManager.ts';
import { updateTenantRecord } from '../tenantRegistry.ts';

export class TenantSheetRepository {
  readonly companyId: string;
  readonly worksheet: WorksheetName;

  constructor(companyId: string, worksheet: WorksheetName) {
    this.companyId = companyId;
    this.worksheet = worksheet;
  }

  async findAllEntries(): Promise<SheetRowEntry[]> {
    const { tables } = await loadTenantSpreadsheetTables(this.companyId);
    return (tables.get(this.worksheet) || []).filter(
      (entry) => !entry.data.company_id || entry.data.company_id === this.companyId
    );
  }

  async findAll(): Promise<Array<Record<string, string>>> {
    const entries = await this.findAllEntries();
    return entries.map((e) => e.data);
  }

  async findById(id: string): Promise<Record<string, string> | null> {
    const entries = await this.findAllEntries();
    const hit = entries.find((e) => e.data.id === id);
    return hit ? hit.data : null;
  }

  async findByField(field: string, value: string): Promise<Array<Record<string, string>>> {
    const entries = await this.findAllEntries();
    return entries.filter((e) => e.data[field] === value).map((e) => e.data);
  }

  async insert(record: Record<string, unknown>): Promise<Record<string, string>> {
    return this.batchInsert([record]).then((rows) => rows[0]);
  }

  async batchInsert(records: Array<Record<string, unknown>>): Promise<Array<Record<string, string>>> {
    if (records.length === 0) return [];
    return withTenantWriteLock(this.companyId, async () => {
      const { tenant, accessToken } = await loadTenantSpreadsheetTables(this.companyId);
      const serializedRows: string[][] = [];
      const outObjects: Array<Record<string, string>> = [];

      for (const rec of records) {
        const scoped = { ...rec, company_id: this.companyId };
        const arr = serializeRowObject(this.worksheet, scoped);
        serializedRows.push(arr);
        const headers = WORKSHEET_HEADERS[this.worksheet];
        const obj: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
          obj[headers[i]] = arr[i];
        }
        outObjects.push(obj);
      }

      await appendWorksheetRows(accessToken, tenant.spreadsheet_id, this.worksheet, serializedRows);
      invalidateTenantCache(this.companyId);
      updateTenantRecord(this.companyId, {
        last_successful_write: new Date().toISOString(),
        last_error: null,
      });
      return outObjects;
    });
  }

  async update(id: string, patch: Record<string, unknown>): Promise<Record<string, string> | null> {
    return withTenantWriteLock(this.companyId, async () => {
      const { tenant, accessToken, tables } = await loadTenantSpreadsheetTables(this.companyId);
      const entries = tables.get(this.worksheet) || [];
      const target = entries.find((e) => e.data.id === id && (!e.data.company_id || e.data.company_id === this.companyId));
      if (!target) return null;

      const merged = { ...target.data, ...patch, id, company_id: this.companyId };
      const rowValues = serializeRowObject(this.worksheet, merged);
      await updateWorksheetRow(accessToken, tenant.spreadsheet_id, this.worksheet, target.rowNumber, rowValues);
      invalidateTenantCache(this.companyId);
      updateTenantRecord(this.companyId, {
        last_successful_write: new Date().toISOString(),
        last_error: null,
      });

      const headers = WORKSHEET_HEADERS[this.worksheet];
      const out: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        out[headers[i]] = rowValues[i];
      }
      return out;
    });
  }

  async batchUpdate(items: Array<{ id: string; patch: Record<string, unknown> }>): Promise<number> {
    if (items.length === 0) return 0;
    return withTenantWriteLock(this.companyId, async () => {
      const { tenant, accessToken, tables } = await loadTenantSpreadsheetTables(this.companyId);
      const entries = tables.get(this.worksheet) || [];
      const endCol = columnIndexToLetter(WORKSHEET_HEADERS[this.worksheet].length - 1);
      const updates: Array<{ range: string; values: string[][] }> = [];

      for (const item of items) {
        const target = entries.find(
          (e) => e.data.id === item.id && (!e.data.company_id || e.data.company_id === this.companyId)
        );
        if (!target) continue;
        const merged = { ...target.data, ...item.patch, id: item.id, company_id: this.companyId };
        const rowValues = serializeRowObject(this.worksheet, merged);
        updates.push({
          range: `'${this.worksheet}'!A${target.rowNumber}:${endCol}${target.rowNumber}`,
          values: [rowValues],
        });
      }

      if (updates.length === 0) return 0;
      await batchUpdateValues(accessToken, tenant.spreadsheet_id, updates);
      invalidateTenantCache(this.companyId);
      updateTenantRecord(this.companyId, {
        last_successful_write: new Date().toISOString(),
        last_error: null,
      });
      return updates.length;
    });
  }

  async delete(id: string): Promise<boolean> {
    return withTenantWriteLock(this.companyId, async () => {
      const { tenant, accessToken, metadata, tables } = await loadTenantSpreadsheetTables(this.companyId);
      const entries = tables.get(this.worksheet) || [];
      const target = entries.find((e) => e.data.id === id && (!e.data.company_id || e.data.company_id === this.companyId));
      if (!target) return false;

      const sheetMeta = metadata.sheets.find((s) => s.title === this.worksheet);
      if (!sheetMeta) return false;

      await deleteWorksheetRow(accessToken, tenant.spreadsheet_id, sheetMeta.sheetId, target.rowNumber - 1);
      invalidateTenantCache(this.companyId);
      updateTenantRecord(this.companyId, {
        last_successful_write: new Date().toISOString(),
        last_error: null,
      });
      return true;
    });
  }
}

export interface MultiTableWriteBatch {
  worksheet: WorksheetName;
  inserts?: Array<Record<string, unknown>>;
  updates?: Array<{ id: string; patch: Record<string, unknown> }>;
}

/**
 * Executa múltiplas inserções/atualizações de forma serializada por empresa.
 * Caso uma etapa intermédia falhe, regista rollback compensatório para inserções recém-criadas.
 */
export async function executeSerializedMultiSheetWrite(
  companyId: string,
  batches: MultiTableWriteBatch[]
): Promise<void> {
  if (batches.length === 0) return;

  await withTenantWriteLock(companyId, async () => {
    const { tenant, accessToken, metadata, tables } = await loadTenantSpreadsheetTables(companyId);
    const completedUpdates: Array<{ range: string; values: string[][] }> = [];
    const insertsBySheet: Array<{ worksheet: WorksheetName; rows: string[][] }> = [];

    for (const batch of batches) {
      const entries = tables.get(batch.worksheet) || [];
      if (batch.updates && batch.updates.length > 0) {
        const endCol = columnIndexToLetter(WORKSHEET_HEADERS[batch.worksheet].length - 1);
        for (const u of batch.updates) {
          const target = entries.find((e) => e.data.id === u.id && (!e.data.company_id || e.data.company_id === companyId));
          if (!target) continue;
          const merged = { ...target.data, ...u.patch, id: u.id, company_id: companyId };
          const rowValues = serializeRowObject(batch.worksheet, merged);
          completedUpdates.push({
            range: `'${batch.worksheet}'!A${target.rowNumber}:${endCol}${target.rowNumber}`,
            values: [rowValues],
          });
        }
      }

      if (batch.inserts && batch.inserts.length > 0) {
        const rows = batch.inserts.map((rec) =>
          serializeRowObject(batch.worksheet, { ...rec, company_id: companyId })
        );
        insertsBySheet.push({ worksheet: batch.worksheet, rows });
      }
    }

    // Aplicar primeiro todas as atualizações numa única chamada batchUpdate
    if (completedUpdates.length > 0) {
      await batchUpdateValues(accessToken, tenant.spreadsheet_id, completedUpdates);
    }

    const appendedTracker: Array<{ worksheet: WorksheetName; count: number }> = [];
    try {
      for (const item of insertsBySheet) {
        await appendWorksheetRows(accessToken, tenant.spreadsheet_id, item.worksheet, item.rows);
        appendedTracker.push({ worksheet: item.worksheet, count: item.rows.length });
      }
    } catch (err) {
      // Compensação best-effort para evitar estado parcial em falhas multi-aba
      try {
        invalidateTenantCache(companyId);
        const refreshed = await loadTenantSpreadsheetTables(companyId);
        for (const tracked of appendedTracker.reverse()) {
          const sheetMeta = metadata.sheets.find((s) => s.title === tracked.worksheet);
          const entries = refreshed.tables.get(tracked.worksheet) || [];
          if (!sheetMeta || entries.length === 0) continue;
          const toDelete = entries.slice(-tracked.count).reverse();
          for (const entry of toDelete) {
            await deleteWorksheetRow(accessToken, tenant.spreadsheet_id, sheetMeta.sheetId, entry.rowNumber - 1);
          }
        }
      } catch {
        // se compensação também falhar por quota, o cache é invalidado e o erro original é propagado
      }
      invalidateTenantCache(companyId);
      throw err;
    }

    invalidateTenantCache(companyId);
    updateTenantRecord(companyId, {
      last_successful_write: new Date().toISOString(),
      last_error: null,
    });
  });
}
