# 财务管理工作台

当前版本为 v1.0.0。GitHub 发布包只包含源码和建库脚本。需要模板下载时，把公司原始 XLSX 放到网站目录并命名为 `monthly-template.xlsx`。

每次迭代更新 `VERSION` 和 `CHANGELOG.md`，建立对应的 Git 标签，并以 `finance-desk-vX.Y.Z.zip` 保存该版本的独立源码快照。推送到 GitHub 后，将同名快照附在标签对应的 Release，用于追溯和恢复旧版。

需要 Node.js 24。解压后在本目录打开 PowerShell。

```powershell
node local.mjs account admin@example.com
node local.mjs
```

把示例邮箱换成你的邮箱。第一条命令生成登录密码，终端只显示一次。第二条启动本机服务。打开 http://127.0.0.1:8787 并使用该账户登录。首次创建的账户拥有管理员权限。

给其他人员建账号时，在终端运行 `node local.mjs account 同事邮箱`，并在网站「人员权限」为该邮箱分配角色。重复运行账号命令会生成新密码并退出旧会话。本机版只监听回环地址。

在「Excel 导入」中下载对应 CSV 模板，用 Excel 填写后保存为 XLSX 或 UTF-8 CSV，再上传并确认预览。应收和月度报表各用一份模板。同编号或同月份的导入记录会替换旧记录，包括已收金额。未导入数据时看板从空库开始。

数据保存在当前目录的 finance.sqlite。关停服务后，可复制该文件进行备份。

## 公司合并报表与收入管理

进入「Excel 导入 → 公司合并财务报表」，选择公司原格式的 XLSX 文件，核对月份和关键指标后确认导入。工作簿应包含合并资产负债表、合并利润表和合并现金流量表。请在 Excel 中重算并保存，系统读取已保存的单元格数值。

系统按合并利润表的报表日期导入当年截至该月的实际月份。同月份记录会更新。合并资产负债表的期末和期初数据只挂在该报表期，原表本年累计列按原值显示。收入管理可按月查看营业收入、成本、毛利、环比和同比。缺少可比月份时以短横线显示。

## 切换到本机 MySQL

先在 Windows 服务中启动已安装的 MySQL 服务。从网站目录打开 PowerShell，用有建库权限的账号登录。密码在 MySQL 提示符中输入。

```powershell
mysql --host=127.0.0.1 --user=root --password
```

在 MySQL 客户端执行 `source mysql-setup.sql`，然后执行 `exit`。首次运行会显示网站专用账号的随机密码。用下列命令将它保存为当前 Windows 用户的 MySQL 登录配置，按提示输入刚生成的密码。

```powershell
mysql_config_editor set --login-path=finance-desk --host=127.0.0.1 --user=finance_desk_app --password
node local.mjs mysql-check
```

关闭正在运行的旧版网站。如果已有 SQLite 业务数据，运行 `node local.mjs mysql-migrate`。已有的 MySQL 同编号记录会保留，旧 SQLite 数据也保留。然后在同一个 PowerShell 窗口运行：

```powershell
$env:FINANCE_STORAGE = 'mysql'
node local.mjs
```

应收、回款余额和月报从本机 MySQL 读写，网站账号、角色和登录会话保存在原 SQLite 文件。以 MySQL 模式启动时，连接或表检查失败会终止启动。

## ERP 导入接口

ERP API 或导出转换程序可生成 UTF-8 JSON 文件，再调用 `node local.mjs erp-import 文件.json`。每批 1 至 500 行。金额使用整数分，日期使用 YYYY-MM-DD。

```json
{"type":"ar","rows":[{"id":"AR-001","customer":"示例客户","issued":"2026-11-01","due":"2026-12-01","amount":1200000,"paid":300000}]}
```

```json
{"type":"report","rows":[{"id":"2026-11","revenue":10000000,"cost":6000000,"expense":2000000,"cash":1600000}]}
```

相同编号或月份会整行更新，包括已收金额。若 ERP 快照里的已收金额落后于网站登记的回款，先核对并合并后再导入。打开的 BI 看板和应收页每 15 秒查询一次，数据提交后下一次查询即显示。ERP 下载频率由后续的 ERP 接入确定。
