"""目录沙箱：所有文件操作都必须落在工作目录内，符号链接也按真实路径校验。"""

from __future__ import annotations

import os
from pathlib import Path


class SandboxError(Exception):
    """路径越界或不可访问"""


class Sandbox:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, raw: str, *, must_exist: bool = False) -> Path:
        if not raw or not str(raw).strip():
            raise SandboxError("路径不能为空")
        target = Path(os.path.expanduser(str(raw).strip()))
        if not target.is_absolute():
            target = self.root / target
        try:
            resolved = target.resolve()
        except OSError as error:
            raise SandboxError(f"无法解析路径：{error}") from error
        if not self._inside(resolved):
            raise SandboxError(
                f"路径超出沙箱范围：{resolved}。当前工作目录是 {self.root}，请使用相对路径。"
            )
        if must_exist and not resolved.exists():
            raise SandboxError(f"路径不存在：{self.relative(resolved)}")
        return resolved

    def _inside(self, path: Path) -> bool:
        try:
            return path == self.root or self.root in path.parents
        except OSError:
            return False

    def relative(self, path: Path) -> str:
        try:
            rel = path.relative_to(self.root)
        except ValueError:
            return str(path)
        return "." if str(rel) == "." else str(rel)

    def display(self, path: Path) -> str:
        rel = self.relative(path)
        return rel

    def ensure_parent(self, path: Path) -> None:
        parent = path.parent
        parent.mkdir(parents=True, exist_ok=True)
        if not self._inside(parent.resolve()):
            raise SandboxError("父目录超出沙箱范围")
