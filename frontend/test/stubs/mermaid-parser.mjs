// @mermaid-js/parser 测试替身（npmmirror 上该包损坏，主构建由 vite alias stub，测试同理）
const noop = async () => ({});
export const parse = noop;
export const parseMermaid = noop;
export const isEmResetFrame = noop;
export const createRailroadServices = noop;
export const MermaidParseError = class extends Error {};
export const createRailroadEbnfServices = async () => ({});
export const createRailroadAbnfServices = async () => ({});
export const createRailroadPegServices = async () => ({});
