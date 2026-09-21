#!/usr/bin/env python3
"""Interactive local ReAct agent. Configuration is read from config.json."""
import argparse
import json
import re
import readline
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


REACT_PROMPT = """你是本地项目编程助手。工作目录：{workdir}
严格使用以下格式回复：需要工具时输出 <thought>简短说明</thought><action>工具名|参数...</action>；完成时输出 <thought>简短总结</thought><final_answer>...</final_answer>。
工具：list_files|相对目录，read_file|相对文件，run_terminal_command|shell命令。
重要规则：只有工具实际返回成功结果后，才能声称文件已创建、下载或保存。涉及本地文件、网络搜索或下载时，必须先调用工具；不能凭空声称已经完成。思考只写简短的可审计理由，不要虚构工具结果。"""


class Agent:
  def __init__(self, workdir: Path):
    self.workdir = workdir.resolve()
    config_path = self.workdir / "config.json"
    try:
      config = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
      raise RuntimeError(f"找不到配置文件：{config_path}") from exc
    except json.JSONDecodeError as exc:
      raise RuntimeError(f"配置文件不是有效 JSON：{config_path}（第 {exc.lineno} 行）") from exc
    if not isinstance(config, dict):
      raise RuntimeError(f"配置文件必须是 JSON 对象：{config_path}")
    missing = [name for name in ("OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL")
               if not isinstance(config.get(name), str) or not config[name].strip()]
    if missing:
      raise RuntimeError(f"配置文件缺少有效字段：{', '.join(missing)}")
    self.api_key = config["OPENAI_API_KEY"].strip()
    self.base_url = config["OPENAI_BASE_URL"].strip().rstrip("/")
    self.model = config["OPENAI_MODEL"].strip()
    self.tools = {"list_files": self.list_files, "read_file": self.read_file,
                  "run_terminal_command": self.run_terminal_command}

  def call_model(self, messages):
    request = Request(f"{self.base_url}/chat/completions",
      data=json.dumps({"model": self.model, "messages": messages, "temperature": 0.2}).encode(),
      headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
    try:
      with urlopen(request, timeout=120) as response:
        status = response.status
        body = response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
      body = exc.read().decode("utf-8", errors="replace")
      raise RuntimeError(
        f"模型接口 HTTP {exc.code}（{self.base_url}）：{body or '响应为空'}"
      ) from exc
    except URLError as exc:
      raise RuntimeError(f"无法连接模型接口：{exc.reason}") from exc
    if not body.strip():
      raise RuntimeError(
        f"模型接口返回空响应（HTTP {status}，{self.base_url}）。"
        "请检查 OPENAI_BASE_URL 是否填写为 API 根地址。"
      )
    try:
      data = json.loads(body)
    except json.JSONDecodeError as exc:
      preview = body[:500].replace("\n", "\\n")
      raise RuntimeError(
        f"模型接口返回的不是有效 JSON（HTTP {status}，{self.base_url}）：{preview}"
      ) from exc
    try:
      return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
      raise RuntimeError(f"模型响应格式不正确：{data}") from exc

  def safe_path(self, value="."):
    path = (self.workdir / (value or ".")).resolve()
    if path != self.workdir and self.workdir not in path.parents:
      raise ValueError("路径不能超出工作目录")
    return path

  def list_files(self, relative_path="."):
    path = self.safe_path(relative_path)
    if not path.is_dir():
      raise ValueError(f"不是目录：{relative_path}")
    return "\n".join(f"{p.name}{'/' if p.is_dir() else ''}" for p in sorted(path.iterdir(), key=lambda x: x.name.lower())) or "（空目录）"

  def read_file(self, relative_path):
    path = self.safe_path(relative_path)
    if not path.is_file():
      raise ValueError(f"不是文件：{relative_path}")
    return path.read_text(encoding="utf-8", errors="replace")[:20000]

  def run_terminal_command(self, command):
    result = subprocess.run(command, cwd=self.workdir, shell=True, text=True,
                            capture_output=True, timeout=120)
    output = (result.stdout + result.stderr).strip()
    return f"退出码：{result.returncode}\n{output}" if output else f"退出码：{result.returncode}"

  def run(self, user_input: str):
    messages = [{"role": "system", "content": REACT_PROMPT.format(workdir=self.workdir)},
                {"role": "user", "content": f"<question>{user_input}</question>"}]
    tool_call_count = 0
    while True:
      content = self.call_model(messages)
      thought_match = re.search(r"<thought>(.*?)</thought>", content, re.DOTALL)
      if thought_match:
        print(f"\n💭 {thought_match.group(1).strip()}")
      final_match = re.search(r"<final_answer>(.*?)</final_answer>", content, re.DOTALL)
      if final_match:
        if tool_call_count:
          print(f"\n📋 工具调用审计：本轮实际调用 {tool_call_count} 次")
        else:
          print("\n📋 工具调用审计：本轮没有实际调用工具")
        return final_match.group(1).strip()
      action_match = re.search(r"<action>(.*?)</action>", content, re.DOTALL)
      if not action_match:
        raise RuntimeError("模型未输出 <action> 或 <final_answer>")
      parts = action_match.group(1).strip().split("|")
      tool_name, args = parts[0].strip(), [p.strip() for p in parts[1:]]
      if tool_name not in self.tools:
        raise RuntimeError(f"未知工具：{tool_name}")
      tool_call_count += 1
      print(f"\n🔧 {tool_name}({', '.join(args)})")
      if tool_name == "run_terminal_command" and input("是否执行此命令？[Y/n] ").strip().lower() not in ("", "y", "yes"):
        observation = "用户拒绝执行该命令"
      else:
        try:
          observation = self.tools[tool_name](*args)
        except Exception as exc:
          observation = f"工具执行错误：{exc}"
      print(f"\n🔍 {observation}")
      messages.append({"role": "assistant", "content": content})
      messages.append({"role": "user", "content": f"<observation>{observation}</observation>"})


def main():
  # Enable terminal line editing so arrow keys move within the current input.
  readline.parse_and_bind("set editing-mode emacs")
  parser = argparse.ArgumentParser(description="启动本地交互式 Agent")
  parser.add_argument("directory", nargs="?", default=".", help="工作目录，默认当前目录")
  args = parser.parse_args()
  workdir = Path(args.directory).expanduser().resolve()
  if not workdir.is_dir():
    parser.error(f"目录不存在：{workdir}")
  try:
    agent = Agent(workdir)
  except RuntimeError as exc:
    parser.error(str(exc))
  print(f"Agent 已启动，工作目录：{workdir}\n输入任务，输入 quit 或 exit 退出。")
  while True:
    try:
      question = input("\n你 > ").strip()
    except (EOFError, KeyboardInterrupt):
      print()
      return 0
    if question.lower() in {"quit", "exit"}:
      return 0
    if not question:
      continue
    try:
      print(f"\n🤖 {agent.run(question)}")
    except Exception as exc:
      print(f"\n错误：{exc}", file=sys.stderr)


if __name__ == "__main__":
  raise SystemExit(main())
