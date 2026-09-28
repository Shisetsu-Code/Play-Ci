from __future__ import annotations

import os
import re
import subprocess
import threading
import urllib.parse
import webbrowser
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk


APP_TITLE = "Play-Ci · GitHub Actions"
TARGET_REL = Path("analysis") / "targets.txt"
TRIGGER_REL = Path("analysis") / "trigger.txt"
WORKFLOW_FILE = "analyze-targets.yml"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def run_git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    process = subprocess.run(
        ["git", *args],
        cwd=root,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if check and process.returncode != 0:
        detail = (process.stderr or process.stdout or "git command failed").strip()
        raise RuntimeError(detail)
    return process


def validate_targets(text: str, max_targets: int = 1000) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()

    for line_number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        parsed = urllib.parse.urlparse(line)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"Línea {line_number}: URL HTTP(S) inválida: {line}")

        normalized = line
        if normalized in seen:
            continue

        seen.add(normalized)
        urls.append(normalized)

        if len(urls) > max_targets:
            raise ValueError(f"El archivo supera el máximo de {max_targets} URLs.")

    if not urls:
        raise ValueError("El archivo no contiene URLs para analizar.")

    return urls


def github_repo_from_remote(remote: str) -> str | None:
    remote = remote.strip()

    ssh = re.match(r"git@github\.com:([^/]+/[^/]+?)(?:\.git)?$", remote)
    if ssh:
        return ssh.group(1)

    try:
        parsed = urllib.parse.urlparse(remote)
    except ValueError:
        return None

    if parsed.hostname != "github.com":
        return None

    path = parsed.path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]

    if path.count("/") != 1:
        return None

    return path


class AnalysisGui(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("760x520")
        self.minsize(680, 460)

        self.root_dir = repo_root()
        self.selected_path: Path | None = None
        self.running = False

        self.file_var = tk.StringVar(value="Ningún archivo seleccionado")
        self.branch_var = tk.StringVar(value="—")
        self.urls_var = tk.StringVar(value="0 URLs")
        self.status_var = tk.StringVar(value="Listo")

        self._build_ui()
        self._refresh_repo_state()

    def _build_ui(self) -> None:
        frame = ttk.Frame(self, padding=14)
        frame.pack(fill="both", expand=True)

        title = ttk.Label(frame, text="Play-Ci · Ejecutar análisis", font=("Segoe UI", 16, "bold"))
        title.pack(anchor="w")

        ttk.Label(
            frame,
            text="Seleccioná un targets.txt y ejecutalo en GitHub Actions.",
        ).pack(anchor="w", pady=(2, 14))

        repo_box = ttk.LabelFrame(frame, text="Repositorio", padding=10)
        repo_box.pack(fill="x")

        ttk.Label(repo_box, text=str(self.root_dir)).grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(repo_box, text="Branch:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Label(repo_box, textvariable=self.branch_var).grid(row=1, column=1, sticky="w", pady=(6, 0))

        file_box = ttk.LabelFrame(frame, text="Targets", padding=10)
        file_box.pack(fill="x", pady=(12, 0))
        file_box.columnconfigure(0, weight=1)

        ttk.Label(file_box, textvariable=self.file_var).grid(row=0, column=0, sticky="ew")
        self.select_button = ttk.Button(file_box, text="Seleccionar targets.txt", command=self._select_file)
        self.select_button.grid(row=0, column=1, padx=(10, 0))
        ttk.Label(file_box, textvariable=self.urls_var).grid(row=1, column=0, sticky="w", pady=(6, 0))

        actions = ttk.Frame(frame)
        actions.pack(fill="x", pady=12)

        self.run_button = ttk.Button(
            actions,
            text="Ejecutar en GitHub Actions",
            command=self._start_run,
            state="disabled",
        )
        self.run_button.pack(side="left")

        self.actions_button = ttk.Button(
            actions,
            text="Abrir GitHub Actions",
            command=self._open_actions,
        )
        self.actions_button.pack(side="left", padx=(8, 0))

        ttk.Label(actions, textvariable=self.status_var).pack(side="right")

        log_box = ttk.LabelFrame(frame, text="Log", padding=8)
        log_box.pack(fill="both", expand=True)

        self.log = tk.Text(log_box, height=15, wrap="word", state="disabled", font=("Consolas", 9))
        self.log.pack(side="left", fill="both", expand=True)

        scrollbar = ttk.Scrollbar(log_box, command=self.log.yview)
        scrollbar.pack(side="right", fill="y")
        self.log.configure(yscrollcommand=scrollbar.set)

        self._append_log("Seleccioná el archivo que querés subir y analizar.")

    def _append_log(self, text: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", text.rstrip() + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _refresh_repo_state(self) -> None:
        try:
            root = run_git(self.root_dir, "rev-parse", "--show-toplevel").stdout.strip()
            if Path(root).resolve() != self.root_dir.resolve():
                raise RuntimeError(f"El script no está dentro del repo esperado: {root}")

            branch = run_git(self.root_dir, "branch", "--show-current").stdout.strip()
            if not branch:
                raise RuntimeError("El repositorio está en detached HEAD.")

            self.branch_var.set(branch)
        except Exception as exc:
            self.branch_var.set("ERROR")
            self._append_log(f"ERROR: {exc}")
            self.run_button.configure(state="disabled")

    def _select_file(self) -> None:
        selected = filedialog.askopenfilename(
            title="Seleccionar targets.txt",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")],
        )
        if not selected:
            return

        path = Path(selected)
        try:
            text = path.read_text(encoding="utf-8-sig")
            urls = validate_targets(text)
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        self.selected_path = path
        self.file_var.set(str(path))
        self.urls_var.set(f"{len(urls)} URLs únicas")
        self.run_button.configure(state="normal")
        self._append_log(f"Archivo seleccionado: {path}")
        self._append_log(f"URLs válidas: {len(urls)}")

    def _set_running(self, running: bool) -> None:
        self.running = running
        self.select_button.configure(state="disabled" if running else "normal")
        self.run_button.configure(
            state="disabled" if running or self.selected_path is None else "normal"
        )
        self.status_var.set("Ejecutando…" if running else "Listo")

    def _start_run(self) -> None:
        if self.running or self.selected_path is None:
            return

        self._set_running(True)
        threading.Thread(target=self._execute, daemon=True).start()

    def _execute(self) -> None:
        try:
            source = self.selected_path
            assert source is not None

            text = source.read_text(encoding="utf-8-sig")
            urls = validate_targets(text)

            branch = run_git(self.root_dir, "branch", "--show-current").stdout.strip()
            if not branch:
                raise RuntimeError("No hay una branch activa.")

            target_path = self.root_dir / TARGET_REL
            trigger_path = self.root_dir / TRIGGER_REL

            target_path.parent.mkdir(parents=True, exist_ok=True)
            trigger_path.parent.mkdir(parents=True, exist_ok=True)

            normalized_text = text
            if not normalized_text.endswith("\n"):
                normalized_text += "\n"
            target_path.write_text(normalized_text, encoding="utf-8")

            current_trigger = 0
            if trigger_path.exists():
                raw = trigger_path.read_text(encoding="utf-8").strip()
                if raw:
                    try:
                        current_trigger = int(raw)
                    except ValueError as exc:
                        raise RuntimeError("analysis/trigger.txt no contiene un entero válido.") from exc

            next_trigger = current_trigger + 1
            trigger_path.write_text(f"{next_trigger}\n", encoding="utf-8")

            self.after(0, self._append_log, f"Branch: {branch}")
            self.after(0, self._append_log, f"Copiando {len(urls)} URLs a {TARGET_REL.as_posix()}")
            self.after(0, self._append_log, f"Trigger: {current_trigger} → {next_trigger}")

            status = run_git(
                self.root_dir,
                "status",
                "--porcelain",
                "--",
                TARGET_REL.as_posix(),
                TRIGGER_REL.as_posix(),
            ).stdout.strip()

            if not status:
                raise RuntimeError("No hay cambios para subir.")

            message = f"Run target analysis {next_trigger}"
            commit = run_git(
                self.root_dir,
                "commit",
                "-m",
                message,
                "--only",
                "--",
                TARGET_REL.as_posix(),
                TRIGGER_REL.as_posix(),
            )
            if commit.stdout.strip():
                self.after(0, self._append_log, commit.stdout.strip())

            self.after(0, self._append_log, "Subiendo a GitHub…")
            push = run_git(self.root_dir, "push", "origin", branch)
            push_output = (push.stdout + "\n" + push.stderr).strip()
            if push_output:
                self.after(0, self._append_log, push_output)

            remote = run_git(self.root_dir, "remote", "get-url", "origin").stdout.strip()
            repo = github_repo_from_remote(remote)
            actions_url = (
                f"https://github.com/{repo}/actions/workflows/{WORKFLOW_FILE}"
                if repo
                else None
            )

            self.after(0, self._append_log, "OK: push completado. GitHub Actions quedó disparado.")
            self.after(0, self._success, actions_url)

        except Exception as exc:
            self.after(0, self._append_log, f"ERROR: {exc}")
            self.after(0, self._failure, str(exc))

    def _success(self, actions_url: str | None) -> None:
        self._set_running(False)
        if actions_url:
            messagebox.showinfo(
                APP_TITLE,
                "El archivo fue subido y el análisis quedó disparado en GitHub Actions.",
            )
            webbrowser.open(actions_url)
        else:
            messagebox.showinfo(
                APP_TITLE,
                "El archivo fue subido y el análisis quedó disparado en GitHub Actions.",
            )

    def _failure(self, message: str) -> None:
        self._set_running(False)
        messagebox.showerror(APP_TITLE, message)

    def _open_actions(self) -> None:
        try:
            remote = run_git(self.root_dir, "remote", "get-url", "origin").stdout.strip()
            repo = github_repo_from_remote(remote)
            if not repo:
                raise RuntimeError("No pude convertir el remote origin en una URL de GitHub.")
            webbrowser.open(f"https://github.com/{repo}/actions/workflows/{WORKFLOW_FILE}")
        except Exception as exc:
            messagebox.showerror(APP_TITLE, str(exc))


if __name__ == "__main__":
    AnalysisGui().mainloop()
