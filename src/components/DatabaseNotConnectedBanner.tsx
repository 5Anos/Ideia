import React from 'react';
import { Database, ArrowRight, AlertTriangle } from 'lucide-react';
import type { NavSectionId } from './Sidebar';

interface DatabaseNotConnectedBannerProps {
  message?: string;
  onNavigateSettings?: () => void;
  onNavigate?: (section: NavSectionId) => void;
}

export const DatabaseNotConnectedBanner: React.FC<DatabaseNotConnectedBannerProps> = ({
  message,
  onNavigateSettings,
  onNavigate,
}) => {
  const handleGoSettings = onNavigateSettings ?? (onNavigate ? () => onNavigate('settings') : undefined);

  return (
    <div
      role="alert"
      data-testid="database-not-connected-banner"
      className="bg-white border border-amber-300 rounded-xl p-6 space-y-4 shadow-xs"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-5 h-5 text-amber-700" />
        </div>
        <div className="space-y-1">
          <h2 className="font-display text-base font-semibold text-slate-900">
            Base de dados Google Sheets da empresa não ligada
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed max-w-2xl">
            {message ||
              'Cada empresa utiliza exclusivamente a sua própria Folha de Cálculo Google como base de dados operacional isolada. Ligue a conta Google empresarial e selecione ou crie a folha de cálculo da empresa para continuar.'}
          </p>
          <p className="text-[11px] text-slate-500">
            Por segurança, o sistema não utiliza bases de dados locais de recurso nem mistura dados entre empresas.
          </p>
        </div>
      </div>

      {handleGoSettings && (
        <div>
          <button
            type="button"
            onClick={handleGoSettings}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <Database className="w-3.5 h-3.5 text-emerald-400" />
            <span>Configurar Google Sheets em Definições</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
