# Changelog

<!-- Prepend releases as ## vX.Y.Z. Keep English first, then Chinese, inside each version section. -->

## v0.1.3

### English

- Fix plugin installation failing on Windows with "EINVAL: invalid argument, futime". The package is now built with the standard tar tooling used by the official Joplin generator, with valid file timestamps.

### 中文

- 修复 Windows 上安装插件失败并提示“EINVAL: invalid argument, futime”的问题；插件包改用 Joplin 官方生成器同款 tar 工具打包，并写入有效的文件时间。

## v0.1.2

### English

- Add Shift-click range selection across list and calendar views, following visible task order and supporting reverse and cross-group selection. Clicking a new endpoint replaces the range; keep selected rows consistently highlighted and preserve Cmd/Ctrl individual selection.
- Allow completed one-time tasks to become recurring tasks, using their existing scheduled date as the default anchor. Preserve the original completion time and history, advance according to recurrence rules and limits, and avoid duplicate completion entries.
- Reduce repeated refresh and snapshot work during bulk actions. Close task menus immediately and show pinning and notebook moves optimistically, reverting to saved state on failure while retaining conflict detection and partial-success reporting.
- Highlight today in the date picker, including for tasks without a date, while keeping the selected date’s outline.

### 中文

- 列表和日历视图支持 Shift 点击范围多选，按可见任务顺序选择，支持反向及跨分组选择；点击新终点时替换选区，统一选中行高亮，并保留 Cmd/Ctrl 逐项多选。
- 已完成的一次性任务可转换为重复任务，默认以原计划日期为基准；保留原完成时间和历史，按重复规则及次数限制推进后续周期，避免重复完成日志。
- 减少批量操作中的重复刷新和快照计算；操作后立即关闭任务菜单，置顶和移动笔记本即时显示结果，保存失败时回退，并保留冲突检测及部分成功提示。
- 日期选择器新增今天的高亮提示，未设置日期的任务也可辨认当天，同时保留已选日期的边框。

## v0.1.1

### English

- Click a notebook name to see all its tasks, including subnotebooks and undated tasks.
- Add native task menus: Today, Tomorrow, +7 days, Clear date and Open settings. Bulk changes keep times and time zones, continue after failures and summarize results. Hide these menus for a single ordinary note.
- Open past recurring notes in their series log without errors; clear leftover menus and errors. Standardize command names and Chinese “Today” wording.
- Add a toolbar toggle and 32px collapsed mini bar; remember panel state and width after restart.
- Set a 400 × 240px minimum panel size and align list/calendar filters, keeping search and trailing controls together.
- Show all day/week tasks; month cells show three tasks with expand/collapse controls.
- Exclude trashed notebooks and notes from views and pickers; avoid full task reloads for notebook renames and reordering.
- Offer one deletion notice with a restore button for an active series’ first note; resume automatically after recovery without duplicate tasks. Ended series retain existing task dates and edits.
- Resume a manually stopped series only by saving its recurrence rules.
- Change the current execution date without shifting recurrence; safely recalculate rule changes and resume after relaxing exhausted limits. Reopening history leaves later tasks and counts intact.
- Add current-task recovery, confirmed whole-series deletion, conversion back to a to-do and a choice of occurrence for multi-device conflicts.
- Update all 26 languages and improve recovery-dialog text layout.

### 中文

- 点击笔记本名称查看该笔记本及子笔记本的全部任务，包含无日期任务。
- 新增原生任务菜单：今天、明天、七天后、清除日期及打开设置。批量改期保留时间和时区，失败后继续并汇总结果；单选普通笔记时隐藏这些入口。
- 历史重复笔记直接打开系列日志，不再报错；清除残留菜单和错误，统一命令名称及中文“今天”用词。
- 新增工具栏开关和 32px 折叠迷你栏，重启后记住面板状态和宽度。
- 面板最小尺寸为 400 × 240px，统一列表/日历筛选布局，搜索框与尾部控件保持同行。
- 日/周视图完整显示任务；月视图每天默认三条，可展开和收起。
- 从视图和选择器排除回收站笔记本及笔记；笔记本改名、排序不再触发全量任务重载。
- 有效系列的第一篇笔记删除时提示一次并提供恢复按钮，恢复后自动续接、不重复生成；已结束系列保留现有任务的日期和后续修改。
- 手动停止的系列只能通过保存重复规则恢复。
- 修改当前执行日期不改变重复节奏；修改规则安全重算，放宽耗尽限制后续接；重新打开历史期不影响后续任务及累计次数。
- 新增当前任务恢复、确认删除整个系列、转回待办及多设备冲突时选择保留周期。
- 更新全部 26 种语言，改善恢复对话框文字布局。
