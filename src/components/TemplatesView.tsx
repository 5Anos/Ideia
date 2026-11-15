import React, { useEffect, useState } from 'react';
import { ArrowRight, Layers } from 'lucide-react';
import { apiFetch } from '../utils/api';
import type { AgentTemplate } from '../shared/types';

interface TemplatesViewProps {
  onSelectTemplate: (template: AgentTemplate) => void;
}

export const TemplatesView: React.FC<TemplatesViewProps> = ({ onSelectTemplate }) => {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('Todos');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ templates: AgentTemplate[] }>('/api/templates')
      .then((res) => setTemplates(res.templates))
      .finally(() => setLoading(false));
  }, []);

  const categories = ['Todos', ...Array.from(new Set(templates.map((t) => t.category)))];
  const filtered =
    selectedCategory === 'Todos'
      ? templates
      : templates.filter((t) => t.category === selectedCategory);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
          Modelos de Agentes
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Biblioteca de modelos pré-configurados. Selecione um modelo para o personalizar no assistente antes da ativação.
        </p>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
              selectedCategory === cat ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-xl h-56 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((tpl) => (
            <div
              key={tpl.id}
              className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-slate-500">{tpl.category}</span>
                  <Layers className="w-4 h-4 text-slate-400" />
                </div>
                <h2 className="font-display text-base font-semibold text-slate-900 mt-1.5">
                  {tpl.name}
                </h2>
                <p className="text-xs text-slate-600 mt-2 leading-relaxed">{tpl.description}</p>

                <div className="mt-4 pt-3 border-t border-slate-100 space-y-1.5 text-[11px] text-slate-500">
                  <p className="font-semibold text-slate-700">Restrições recomendadas:</p>
                  {tpl.recommended_restrictions.slice(0, 2).map((r, i) => (
                    <p key={i}>· {r}</p>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => onSelectTemplate(tpl)}
                className="mt-5 w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <span>Personalizar Modelo</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
