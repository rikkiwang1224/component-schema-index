export interface McpServerOptions {
  /** Include list-icons tool (requires iconProvider) */
  enableIcons?: boolean;
  /** Custom icon summary provider keyed by platform */
  iconProvider?: (platform: string) => unknown;
}
