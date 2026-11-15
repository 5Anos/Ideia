export function formatEUR(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('pt-PT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDatePT(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '—';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

export function formatDateTimePT(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '—';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${mins}`;
}

export const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Proprietário (OWNER)',
  ADMIN: 'Administrador (ADMIN)',
  APPROVER: 'Aprovador (APPROVER)',
  OPERATOR: 'Operador (OPERATOR)',
  VIEWER: 'Leitura (VIEWER)',
};

export const AGENT_STATUS_META: Record<string, { label: string; textClass: string }> = {
  draft: { label: 'Rascunho', textClass: 'text-slate-600' },
  active: { label: 'Ativo', textClass: 'text-emerald-700' },
  running: { label: 'Em execução', textClass: 'text-emerald-800 font-semibold' },
  suspended: { label: 'Suspenso', textClass: 'text-amber-700' },
  archived: { label: 'Arquivado', textClass: 'text-slate-400' },
};

export const DECISION_META: Record<string, { label: string; textClass: string }> = {
  ALLOWED: { label: 'Permitida', textClass: 'text-emerald-700 font-medium' },
  REQUIRES_APPROVAL: { label: 'Requer Aprovação', textClass: 'text-amber-700 font-medium' },
  BLOCKED: { label: 'Bloqueada', textClass: 'text-red-700 font-medium' },
};

export const RISK_LABELS: Record<string, { label: string; textClass: string }> = {
  low: { label: 'Baixo', textClass: 'text-slate-600' },
  medium: { label: 'Médio', textClass: 'text-amber-700' },
  high: { label: 'Elevado', textClass: 'text-red-700' },
  critical: { label: 'Crítico', textClass: 'text-red-800 font-semibold' },
};
