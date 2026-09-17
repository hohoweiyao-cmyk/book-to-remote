-- cdp-allow-dialog.applescript
-- 自动点击 Chrome / Chromium 系的「要允许远程调试吗？」授权弹窗。
--
-- 为什么需要它：chrome://inspect 的那个开关只负责「把 9222 端口打开」，
-- 另有一个独立的、按「每条新建 WebSocket 连接」生效的授权弹窗负责「允许谁连」。
-- Chrome 官方明确拒绝让后者持久化（chrome-devtools-mcp#825，closed as not planned），
-- 所以只能靠外部把弹窗点掉。
--
-- 用法： osascript cdp-allow-dialog.applescript
-- 返回： NO_ACCESS | NO_BROWSER | CLICKED<TAB>应用名<TAB>按钮名 | NO_MATCH | CLICK_FAILED<TAB>原因
--
-- 安全守卫（三层，任一不满足都不点）：
--   1. 只扫指定浏览器的进程
--   2. 容器必须是 dialog / sheet / alert / modal 角色
--   3. 弹窗文本必须命中远程调试类关键词
-- 若只想观察不点击，把环境变量 CDP_ALLOW_DRY=1 传进来（见 .sh 驱动脚本）。

-- 只在「真的点了」或「点击失败」时写日志，避免定时轮询刷爆日志文件。
-- 权限未开的情况不在这里记，交给 cdp-setup.sh --status 报告。
on logLine(msg)
	try
		set stamp to do shell script "/bin/date '+%Y-%m-%d %H:%M:%S'"
		set logPath to (POSIX path of (path to home folder)) & "Library/Logs/cdp-allow-dialog.log"
		do shell script "/bin/echo " & quoted form of (stamp & " " & msg) & " >> " & quoted form of logPath
	end try
end logLine

on trimmed(t)
	set s to t as text
	repeat while s starts with " "
		if (length of s) ≤ 1 then return ""
		set s to text 2 thru -1 of s
	end repeat
	repeat while s ends with " "
		if (length of s) ≤ 1 then return ""
		set s to text 1 thru -2 of s
	end repeat
	return s
end trimmed

on anyHit(haystack, needles)
	repeat with rawNeedle in needles
		set needle to my trimmed(rawNeedle as text)
		if needle is not "" then
			ignoring case
				if haystack contains needle then return true
			end ignoring
		end if
	end repeat
	return false
end anyHit

-- 把一个 UI 元素所有能读到的文本拼起来
on elText(e)
	set out to ""
	try
		set out to out & " " & (name of e as text)
	end try
	try
		set out to out & " " & (title of e as text)
	end try
	try
		set out to out & " " & (description of e as text)
	end try
	try
		set out to out & " " & (value of e as text)
	end try
	return out
end elText

-- 递归收集容器内文本（限深，避免 UI 树太深时卡住）
on collectText(container, depth)
	set out to " " & (my elText(container))
	if depth ≥ 5 then return out
	try
		tell application "System Events" to set kids to (UI elements of container)
		repeat with k in kids
			set out to out & (my collectText(contents of k, depth + 1))
		end repeat
	end try
	return out
end collectText

-- 递归找按钮：优先名字命中的，退而求其次取该层最后一个按钮（macOS 惯例右侧是同意）
on findButton(container, names, depth)
	try
		tell application "System Events" to set btns to (buttons of container)
		repeat with b in btns
			set bObj to contents of b
			if my anyHit(my trimmed(my elText(bObj)), names) then return bObj
		end repeat
		if (count of btns) > 0 then return contents of (item -1 of btns)
	end try
	if depth ≥ 6 then return missing value
	try
		tell application "System Events" to set kids to (UI elements of container)
		repeat with k in kids
			set found to my findButton(contents of k, names, depth + 1)
			if found is not missing value then return found
		end repeat
	end try
	return missing value
end findButton

on run argv
	set appNames to {"Google Chrome", "Google Chrome Beta", "Google Chrome Canary", "Chromium", "Microsoft Edge", "Brave Browser", "Arc"}
	set buttonNames to {"允许", "始终允许", "同意", "确定", "继续", "Allow", "Allow this time", "Always allow", "OK", "Continue"}
	set keywords to {"远程调试", "Remote Debugging", "remote-debugging", "调试此浏览器", "开发者工具", "Chrome DevTools", "DevTools", "CDP", "debugging", "inspect this browser", "control this browser", "自动化测试"}
	set roleWords to {"dialog", "sheet", "alert", "modal", "AXDialog", "AXSheet", "对话", "警告", "面板"}

	tell application "System Events"
		if UI elements enabled is false then return "NO_ACCESS"
	end tell

	set sawBrowser to false

	tell application "System Events"
		repeat with rawApp in appNames
			set appName to rawApp as text
			if exists process appName then
				set sawBrowser to true
				tell process appName
					repeat with w in windows
						set containers to {}
						-- 窗口级 sheet（Chrome 的授权弹窗多半挂在这里）
						try
							tell application "System Events" to set containers to containers & (sheets of w)
						end try
						-- 窗口本身就是 dialog 角色时也算
						try
							set rText to ""
							set rText to rText & (role description of w as text)
							set rText to rText & " " & (subrole of w as text)
							if my anyHit(rText, roleWords) then set end of containers to w
						end try

						repeat with c in containers
							set cObj to contents of c
							set dText to my collectText(cObj, 0)
							if my anyHit(dText, keywords) then
								set btn to my findButton(cObj, buttonNames, 0)
								if btn is not missing value then
									set bText to my trimmed(my elText(btn))
									try
										set frontmost of process appName to true
									end try
									-- 置前后按钮引用可能失效，重新定位一次
									set btn2 to my findButton(cObj, buttonNames, 0)
									if btn2 is missing value then set btn2 to btn
									try
										click btn2
										my logLine("已自动点击: " & appName & " / " & bText)
										return "CLICKED" & tab & appName & tab & bText
									on error errMsg number errNum
										try
											perform action "AXPress" of btn2
											my logLine("已自动点击(AXPress): " & appName & " / " & bText)
											return "CLICKED" & tab & appName & tab & bText
										on error errMsg2
											my logLine("点击失败: " & errNum & " " & errMsg)
											return "CLICK_FAILED" & tab & errNum & tab & errMsg & " / " & errMsg2
										end try
									end try
								end if
							end if
						end repeat
					end repeat
				end tell
			end if
		end repeat
	end tell

	if sawBrowser is false then return "NO_BROWSER"
	return "NO_MATCH"
end run
