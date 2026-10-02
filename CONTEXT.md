# tania

私と AI エージェントが一緒に仕事を進めるための個人用 Agentic Workspace。monica の後継で、Workbench（端末）を引き継ぎ、Task を作り直す。

## Language

### Workbench

**Workbench**:
端末を扱う desktop の画面。Runspace を並べ、各 Runspace の Tab を表示する。
_Avoid_: Work Bench, terminal view

**Runspace**:
Workbench のサイドバーの 1 項目。cwd と環境変数を共有する Tab の束。
_Avoid_: workspace

**Tab**:
Runspace 内の 1 枚の端末画面。閉じても Terminal Session は止まらず detach されるだけ。

**Terminal Session**:
ptyd が持つ 1 つの PTY。app より長生きし、再 attach すると transcript を replay する。
_Avoid_: session（Agent Session と紛れる）

**Agent Session**:
Tab の中で動く agent が自分で名乗るセッション。Terminal Session とは別物で、同じ Tab に両方が存在する。

**ptyd**:
Terminal Session を管理する常駐 daemon。desktop からは socket 越しに使う。
