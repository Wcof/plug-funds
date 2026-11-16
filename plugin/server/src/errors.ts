/**
 * 服务层错误分类：把「用户 / 外部数据的问题」与「程序内部故障」区分开，
 * 避免 CSV 表头写错、备份文件不合法这类输入错误被上报成 500 internal-error。
 */
export class ValidationError extends Error {
  readonly code = 'validation-error';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  readonly code = 'not-found';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
