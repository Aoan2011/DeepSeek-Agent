"""配置、令牌与本地 MCP 清单的读取。"""

from __future__ import annotations

import json
import os
import secrets
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "agentdesk"


def app_dir() -> Path:
    custom = os.environ.get("AGENTDESK_HOME")
    base = Path(custom).expanduser() if custom else Path.home() / f".{APP_NAME}"
    base.mkdir(parents=True, exist_ok=True)
    return base


def config_path() -> Path:
    return app_dir() / "config.json"


def default_sandbox() -> Path:
    return Path(os.environ.get("AGENTDESK_SANDBOX", Path.home() / "AgentWorkspace")).expanduser()


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    token: str = ""
    sandbox: Path = field(default_factory=default_sandbox)
    web_root: Path | None = None
    web_port: int = 8890
    allowed_origins: list[str] = field(default_factory=list)
    mcp_config: Path | None = None
    allow_shell: bool = True
    max_output: int = 200_000

    def describe(self) -> dict:
        return {
            "name": "AgentDesk",
            "version": "1.0.0",
            "platform": f"{sys.platform} · Python {sys.version.split()[0]}",
            "sandbox": str(self.sandbox),
            "capabilities": ["files", "shell", "python", "mcp"],
        }


def read_config_file() -> dict:
    path = config_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def load_token(*, refresh: bool = False) -> str:
    """读取或生成访问令牌；令牌只保存在用户目录，权限 0600。"""
    data = read_config_file()
    token = "" if refresh else str(data.get("token", ""))
    if not token:
        token = secrets.token_urlsafe(18)
        data["token"] = token
        save_config(data)
    return token


def save_config(data: dict) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def load_mcp_servers(path: Path | None) -> dict[str, dict]:
    """
    读取 MCP 配置。支持 Claude Desktop 风格：
    {"mcpServers": {"name": {"command": "...", "args": [], "env": {}}}}
    默认查找 --mcp-config 指定的文件、./mcp.json、~/.agentdesk/mcp.json。
    """
    candidates: list[Path] = []
    if path:
        candidates.append(path)
    else:
        candidates.extend([Path.cwd() / "mcp.json", app_dir() / "mcp.json"])
    for candidate in candidates:
        try:
            if not candidate.exists():
                continue
            payload = json.loads(candidate.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        servers = payload.get("mcpServers", payload)
        if not isinstance(servers, dict):
            continue
        result: dict[str, dict] = {}
        for name, item in servers.items():
            if not isinstance(item, dict) or not item.get("command"):
                continue
            if item.get("disabled") is True:
                continue
            result[str(name)] = item
        if result:
            return result
    return {}


ORIGIN_HINT = (
    "允许的来源：https://*.github.io、http://localhost:*、http://127.0.0.1:*、file://"
)
