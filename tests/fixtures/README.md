# Fixtures 与独立判据

`lunar-oracle.ts` 为 2026-10-24 从香港天文台官方年度文字表核对的事实日期，手工转录，未调用生产农历库生成。覆盖春节跨年、大小月、2023闰二月、2025闰六月以及29日除夕。当前为20个独立样本，不代表1901—2099全范围逐日核验已完成。

来源：

- [2023 年表](https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T2023c.txt)
- [2024 年表](https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T2024c.txt)
- [2025 年表](https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T2025c.txt)
- [2026 年表](https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T2026c.txt)

`tests/support/memory-joplin.ts` 是可注入失败和超时的进程内替身，用于验证应用对宿主调用的响应。它不实现或证明 Joplin 的真实双端同步、资源垃圾回收、通知调度或userData完整合并语义；这些仍需隔离宿主与真机验证。

## Joplin面板宿主fixture

joplin-panel-host.ts根据本机Joplin3.7.21 app.asar的UserWebviewIndex.html/js只读核对。模拟html外层overflow hidden、两个content包装和纵向flex；用于纠正此前body直接挂root的不足。fixture不是完整Joplin实现，布局用例必须有真实renderer，默认跳过不能视为通过。
