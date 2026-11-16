/**
 * RPC 封套与方法表（PRD §8.4：响应统一 `{ success, data, error, traceId }`）。
 *
 * 方法名对齐 PRD 命令合约；同一方法表将复用于后续 Zcode / MCP 适配层。
 */

export interface RpcErrorBody {
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

export interface RpcEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: RpcErrorBody;
  traceId: string;
}

export function ok<T>(traceId: string, data: T): RpcEnvelope<T> {
  return { success: true, data, traceId };
}

export function fail(
  traceId: string,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): RpcEnvelope<never> {
  return { success: false, error: { code, message, extra }, traceId };
}

/** v1 RPC 方法全集（与 PRD §8.4 对齐；实现以 server/api.ts 的 HANDLERS 为准）。 */
export const RPC_METHODS = [
  'get_app_info',
  'get_dashboard_summary',
  'get_dashboard_allocation',
  'get_portfolio_goal',
  'save_portfolio_goal',
  'get_portfolio_performance_metrics',
  'list_accounts',
  'save_account',
  'archive_account',
  'search_instruments',
  'save_instrument',
  'list_positions',
  'get_position_detail',
  'record_transaction',
  'list_transactions',
  'delete_position',
  'pin_position',
  'list_categories',
  'save_category',
  'delete_category',
  'set_instrument_categories',
  'get_instrument_chart_series',
  'get_instrument_detail',
  'get_holdings_valuation',
  'analyze_holding_with_ai',
  'get_ai_settings',
  'save_ai_settings',
  'test_ai_connection',
  'compare_instruments',
  'refresh_market_data',
  'export_backup',
  'export_holdings_csv',
  'save_manual_price',
  'set_hide_amount',
  'save_portfolio_cash_flow',
  'delete_portfolio_cash_flow',
  'preview_import_transactions',
  'commit_import_transactions',
  'preview_restore_backup',
  'restore_backup',
  'list_strategy_templates',
  'save_strategy_template',
  'list_strategy_versions',
  'restore_strategy_version',
  'save_manual_metric',
  'get_refresh_settings',
  'save_refresh_settings',
  'get_index_valuation',
  'get_decision_readiness',
  'seed_common_indices',
  'bootstrap_indices',
  'get_portfolio_risk',
  'save_risk_settings',
  'get_correlation_matrix',
  'list_cash_accounts',
  'save_cash_account',
  'delete_cash_account',
  'get_rebalance_plan',
  'save_rebalance_targets',
  'get_trading_calendar',
  'get_index_analytics',
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];
