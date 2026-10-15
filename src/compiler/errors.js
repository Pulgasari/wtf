export class LsdCompileError extends Error {
  constructor(message, { filename, loc, cause } = {}) {
    const where = loc ? `${filename ?? '<input>'}:${loc.line}:${loc.column + 1}` : filename;
    super(where ? `${where}: ${message}` : message, { cause });
    this.name = 'LsdCompileError';
    this.filename = filename;
    this.loc = loc;
  }
}
