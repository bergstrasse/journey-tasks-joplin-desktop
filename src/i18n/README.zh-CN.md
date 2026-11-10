# 界面语言设计

[English](README.md)

界面使用独立 JSON 词典，目前提供 26 个语言／地区选项，以 `registry.ts` 为准。语言偏好按设备保存，可选 `auto` 或注册的语言 ID。自动模式在插件启动时读取一次 Joplin locale，先调用 `settings.globalValues`，调用失败时再尝试旧版 `settings.globalValue` API；宿主语言不可用或为空时使用美国英语（`en-US`）。修改 Joplin 语言后需要重启插件，运行期间不轮询宿主语言。

## 修改现有翻译

修改德语时编辑 `locales/de.json`；其他语言也各有独立文件，位于 `locales/`。可对照 `locales/en.json` 或 `locales/zh-CN.json`，所有词典使用相同的平铺语义键。

- 只翻译值，保留 `actions.refresh` 等键名。
- 保留 `{title}`、`{count}` 等具名参数及其名称。缺少参数时保留占位符，插入的值不会再次翻译或展开。
- 原文包含 `<!-- template:start -->`、`<!-- template:end -->` 等模板标记时，必须原样保留。
- 保留全部键，并提供非空值。缺译时回退简体中文；两份词典均无此键时返回键本身。这些回退不能视为翻译完成。

新增语言最初使用机器翻译。自动检查可验证结构、参数和模板标记，但不能保证语言质量，欢迎人工校译。全部词典离线打包，运行时不调用翻译服务。

## 新增语言

1. 复制 `locales/en.json` 为 `locales/xx.json`，按上述规则翻译值。
2. 在 `registry.ts` 中导入并注册，使用唯一语言 ID 和母语名称：

   ```ts
   import example from './locales/xx.json';

   // 在 registry 对象中新增：
   xx: { id: 'xx', nativeName: 'Language name', dictionary: example },
   ```

3. 语言选项和偏好验证自动跟随注册表，无需修改任务模型或存储验证。检查 `resolveLanguage` 的地区／脚本匹配逻辑；新增从右向左书写的语言时还需检查 `languageDirection`。目前只有波斯语（`fa`）使用 RTL。
4. 修改语言数量时，同步更新 `tests/unit/i18n.test.ts` 和 `tests/package-smoke.test.ts` 中明确要求 26 种语言的断言，并检查中英文两版说明中的数量。

## 运行逻辑

`resolveLanguage(preference, locales)` 接受语言字符串或按优先级排列的列表。显式注册的偏好优先。自动匹配会统一下划线和大小写，然后对每个候选先匹配完整注册 ID，再匹配语言家族。中文脚本优先于地区：`Hant` 选择繁体，`Hans` 选择简体；无脚本时，`TW`、`HK`、`MO` 选择繁体。无地区的罗马尼亚语默认选择 `ro-RO`。全部候选均不支持时回退 `en-US`。未传入语言提示时，辅助函数使用浏览器语言偏好或运行环境的 Intl locale。

`createTranslator(locale)` 返回不依赖 React 的 `t(key, params?)`；未注册的 locale 使用 `en-US` 词典。`TranslationProvider` 与 `useTranslation` 位于 `react.tsx`，使用插件打包的 React 实例。没有 Provider 的组件默认使用简体中文。保存语言偏好后面板立即更新；宿主注册的菜单标签在下次启动插件时更新。

语言切换只影响界面文案，不修改用户标题、笔记正文、笔记本名称、模板、日期计划、时区或重复规则。用户内容作为插值数据传入，不作为翻译键查找。无日期任务不会因切换语言被重新安排。内部日历日期值使用 ISO 日期；显示形式还受日历选择和语言影响。时间通过 Intl 按当前语言及独立的 12／24 小时偏好显示。

`translateMessage` 翻译已知错误码及完全匹配的已知中英文诊断消息，未知消息原样保留。仅用于错误／诊断通道，不用于用户内容，也不扫描 DOM。错误文案应统一放在语言词典中，避免翻译表散落组件。

## 验证与构建体积

在仓库根目录运行：

```sh
npm run typecheck
node --import tsx --test tests/unit/i18n.test.ts tests/unit/translation-usage.test.ts tests/integration/language.test.ts tests/integration/host-language.test.ts tests/integration/panel-language.test.ts
npm run build
npm run verify:package
```

语言测试检查词条键、非空值、具名参数、模板标记、语言解析、偏好持久化和界面渲染。还需在面板中人工检查译文，尤其是窄屏、确认窗及适用的 RTL 布局。

源 JSON 文件是唯一翻译来源。面板构建共享词条键名并压缩重复译文，运行时还原完整词典，所有注册语言均可离线切换。后台构建先分析入口依赖图，再仅保留后台业务源码中以完整字符串字面量引用的词条，包括命令、通知和默认标题。后台新增翻译调用需使用完整字面量键；动态拼接的键不会自动保留。面板完整词典不会进入后台包。

支持二维码通过 CSS 相对路径引用独立 PNG，构建自动将其加入 JPL。构建日志与 `publish/build-metadata.json` 记录各产物字节数。打包冒烟测试验证归档内容、26 种语言及后台词条子集在构建前后的词典一致性，并限制 JPL 不超过 1,500,000 字节。增加译文时可能需要检查构建体积预算。
