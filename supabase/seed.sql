-- MANDATO — Dados de Demonstração (Empresa Demonstração)
-- Nota: Execute após 001_initial_schema.sql numa instância Supabase PostgreSQL.

INSERT INTO companies (id, name, slug, nif, sector, subscription_plan, is_demo)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'Empresa Demonstração',
  'empresa-demonstracao',
  '509123456',
  'Serviços Empresariais e Distribuição',
  'PROFESSIONAL',
  TRUE
) ON CONFLICT (id) DO NOTHING;

-- Políticas base da Empresa Demonstração
INSERT INTO policies (id, company_id, name, description, action_type, rule_type, max_auto_amount, max_approval_amount, currency, is_absolute_restriction, status, is_demo)
VALUES
  ('21111111-1111-4111-8111-111111111101', '11111111-1111-4111-8111-111111111111', 'Política de Compras Operacionais', 'Permite compras até 300 EUR automaticamente; 300-1.000 EUR exige aprovação; acima de 1.000 EUR bloqueado.', 'purchase_order', 'financial_threshold', 300.00, 1000.00, 'EUR', FALSE, 'active', TRUE),
  ('21111111-1111-4111-8111-111111111102', '11111111-1111-4111-8111-111111111111', 'Política de Reembolsos a Clientes', 'Permite reembolsos até 50 EUR; acima de 50 EUR requer aprovação; destinos não verificados bloqueados.', 'refund', 'financial_threshold', 50.00, 500.00, 'EUR', FALSE, 'active', TRUE),
  ('21111111-1111-4111-8111-111111111103', '11111111-1111-4111-8111-111111111111', 'Proteção Absoluta de Dados Bancários', 'Proibição absoluta de alteração de IBAN ou dados bancários de fornecedores por agentes.', 'bank_details_update', 'block_always', NULL, NULL, 'EUR', TRUE, 'active', TRUE),
  ('21111111-1111-4111-8111-111111111104', '11111111-1111-4111-8111-111111111111', 'Comunicação Externa com Clientes', 'Rascunhos permitidos; envio de mensagens externas exige aprovação humana.', 'send_message', 'require_approval', NULL, NULL, 'EUR', FALSE, 'active', TRUE),
  ('21111111-1111-4111-8111-111111111105', '11111111-1111-4111-8111-111111111111', 'Registo de Novos Fornecedores', 'Leitura permitida; criação de novos fornecedores requer validação humana.', 'create_supplier', 'require_approval', NULL, NULL, 'EUR', FALSE, 'active', TRUE)
ON CONFLICT (id) DO NOTHING;
