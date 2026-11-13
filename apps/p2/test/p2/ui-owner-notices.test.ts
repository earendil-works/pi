// Notice UI uses real pointer events and native error/log handles; only dev HTTP replies are deterministic fixtures.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { LogNotices } from "../../plugins/logs/contract.ts";
import { processLogs } from "../../src/runtime/logs.ts";
import { Browser, browserTests } from "./browser.ts";
import { startFixture, until } from "./helpers.ts";

for (const [width, height] of [
	[390, 844],
	[1280, 900],
])
	test(
		`one themed owner notice lane at ${width}×${height}: clear controls, details, auto-dismiss and persistent failures`,
		{ skip: !browserTests, timeout: 90_000 },
		async (t) => {
			const fixture = await startFixture({ web: true });
			t.after(() => fixture.close());
			const browser = await Browser.start();
			await browser.signIn(fixture.owner);
			t.after(() => browser.close());
			await browser.metrics(width, height);
			const plugins = [
				"status",
				"conversations",
				"models",
				"subagents",
				"search",
				"sessions",
				"envs",
				"files",
				"drafts",
				"chat",
				"chat-mode",
			];
			await browser.call("Page.addScriptToEvaluateOnNewDocument", {
				source: `
		window.noticeStatus={revision:1,phase:'idle',plugins:[],dirty:['models','chat','sessions'],restartNeeded:true,hasLogs:true};window.noticeCommands=[];window.noticePolls=0;
		const originalFetch=window.fetch.bind(window);window.fetch=async(url,options)=>{
			if(String(url)!=='/__p2_dev')return originalFetch(url,options);
			if(options?.method==='POST'){
				const command=JSON.parse(options.body);window.noticeCommands.push(command);
				if(command.action==='reload')window.noticeStatus={revision:2,phase:'ready',plugins:${JSON.stringify(plugins)},dirty:[],restartNeeded:false,noticeId:'reload-fixture',noticeTime:Date.now(),message:'Reloaded '+${JSON.stringify(plugins)}.join(', '),hasLogs:true};
				return new Response(JSON.stringify({ok:true,message:command.action==='reload' ? window.noticeStatus.message : 'Restart requested',plugins:command.action==='reload' ? ${JSON.stringify(plugins)} : []}),{headers:{'Content-Type':'application/json'}});
			}
			window.noticePolls++;return new Response(JSON.stringify(window.noticeStatus),{headers:{'Content-Type':'application/json'}});
		};
	`,
			});
			await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
			await browser.wait(
				`document.querySelector('.composer textarea') && document.querySelectorAll('.owner-notice.pending').length===2 && !document.querySelector('.offline')`,
			);
			await browser.evaluate(
				`document.documentElement.style.setProperty('--safe-top','24px');document.documentElement.style.setProperty('--safe-bottom','20px');`,
			);
			const layout = async () => {
				const geometry = await browser.evaluate<{
					clear: boolean;
					inside: boolean;
					targets: boolean;
					theme: boolean;
				}>(`(()=>{
			const lane=document.querySelector('.owner-notices'),composer=document.querySelector('.dock'),top=document.querySelector('.topbar');
			const r=lane.getBoundingClientRect(),d=composer.getBoundingClientRect(),bar=top.getBoundingClientRect();
			const buttons=[...lane.querySelectorAll('button')],boxes=buttons.map(e=>e.getBoundingClientRect());
			return {clear:r.top>=bar.bottom && r.bottom<=d.top,inside:r.left>=0&&r.right<=innerWidth,
				targets:boxes.every(a=>a.width>=44&&a.height>=44)&&boxes.every((a,i)=>boxes.every((b,j)=>i===j||a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top)),
				theme:getComputedStyle(lane).backgroundColor===getComputedStyle(document.body).backgroundColor||getComputedStyle(lane).backgroundColor===getComputedStyle(document.documentElement).backgroundColor};
		})()`);
				assert(geometry.clear, "notice lane is below the safe-area top bar and above, never over, the composer");
				assert(geometry.inside);
				assert(geometry.targets, "each real button has a separate 44px hit target");
				assert(geometry.theme);
			};
			for (const theme of ["light", "dark"]) {
				await browser.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
				await layout();
			}
			assert.match(
				await browser.evaluate<string>(`document.querySelector('.owner-notices').textContent`),
				/Server code changed/,
			);
			assert.match(
				await browser.evaluate<string>(`document.querySelector('.owner-notices').textContent`),
				/3 plugins changed/,
			);
			await browser.click(".owner-notice.pending:last-child button");
			await browser.wait(`window.noticeCommands[0]?.action==='restart'`);
			await browser.click(".owner-notice.pending:first-child button");
			await browser.wait(
				`window.noticeCommands[1]?.action==='reload' && document.querySelector('.owner-notice.success .owner-notice-summary')?.textContent==='Reloaded 11 plugins' && !document.querySelector('.owner-notice.pending')`,
			);
			await layout();
			await browser.click(".owner-notice.success .owner-notice-summary");
			await browser.wait(
				`document.querySelector('[role=dialog][aria-label="Reloaded 11 plugins"] .owner-notice-details')?.textContent.includes('chat-mode')`,
			);
			assert.equal(
				await browser.evaluate<string>(`document.querySelector('.owner-notice-details').textContent`),
				plugins.join("\n"),
			);
			// Replacing an acknowledgement with the next server notice cannot close its open details.
			await browser.evaluate(`window.noticeStatus.noticeId='reload-next-status'`);
			const detailPoll = await browser.evaluate<number>("window.noticePolls");
			await browser.wait(`window.noticePolls>=${detailPoll + 2}`);
			assert.equal(
				await browser.evaluate<string>(`document.querySelector('.owner-notice-details').textContent`),
				plugins.join("\n"),
			);
			await browser.click("[role=dialog] button[aria-label=Close]");
			await browser.wait(`document.querySelector('.owner-notice.success')`);
			const polls = await browser.evaluate<number>("window.noticePolls");
			await browser.wait(`!document.querySelector('.owner-notice.success') && window.noticePolls>=${polls + 8}`);
			// The unchanged backend message keeps polling; it must not remount a success after expiry.
			await browser.wait(`window.noticePolls>=${polls + 11}`);
			assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.owner-notice.success').length`), 0);
			const failure = "Reload refused: Fixture syntax error; previous code is still running";
			processLogs.notice("server", failure);
			await browser.evaluate(
				`window.noticeStatus={revision:3,phase:'error',plugins:[],dirty:['chat'],restartNeeded:false,message:${JSON.stringify(failure)},noticeId:'failure-fixture',noticeTime:Date.now(),hasLogs:true};`,
			);
			await browser.wait(
				`document.querySelector('.owner-notice.error')?.textContent.includes('Fixture syntax error') && document.querySelector('.owner-notice.pending') && window.noticePolls>=${polls + 13}`,
			);
			assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.owner-notices').length`), 1);
			assert.equal(
				await browser.evaluate<number>(`document.querySelectorAll('.owner-notice.error').length`),
				1,
				"dev and native error feeds render only one refusal",
			);
			for (const theme of ["light", "dark"]) {
				await browser.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
				await layout();
			}
			await browser.evaluate(
				`document.querySelector('.owner-notice.error button.button').classList.add('test-show-logs')`,
			);
			await browser.click(".test-show-logs");
			await browser.wait(`document.querySelector('#logs-source')?.value==='server'`);
			await browser.click("[role=dialog] button[aria-label=Close]");
			const failedPolls = await browser.evaluate<number>("window.noticePolls");
			await browser.wait(`window.noticePolls>=${failedPolls + 12}`);
			assert.equal(
				await browser.evaluate<number>(`document.querySelectorAll('.owner-notice.error').length`),
				1,
				"failures remain past success expiry",
			);
			assert.equal(
				await browser.evaluate<number>(`document.querySelectorAll('.owner-notice.pending').length`),
				1,
				"pending changes also persist",
			);
			const notices = fixture.browser().hold(LogNotices, {}, BACKGROUND_CONTEXT);
			await whenLive(notices);
			await browser.click('.owner-notice.error button[aria-label="Dismiss owner notice"]');
			await browser.wait(`!document.querySelector('.owner-notice.error')`);
			await until(notices.notices, (rows) => !rows?.some((row) => row.message === failure));
			notices.release();
			await browser.wait(`window.noticePolls>=${failedPolls + 15}`);
			assert.equal(
				await browser.evaluate<number>(`document.querySelectorAll('.owner-notice.error').length`),
				0,
				"polling cannot resurrect a dismissed failure",
			);
		},
	);

test(
	"a rejected dev command persists across unchanged polls and does not cover a keyboard-sized composer",
	{ skip: !browserTests },
	async (t) => {
		const fixture = await startFixture({ web: true });
		t.after(() => fixture.close());
		const browser = await Browser.start();
		await browser.signIn(fixture.owner);
		t.after(() => browser.close());
		await browser.metrics(390, 844);
		await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `
		window.noticePolls=0;const original=window.fetch.bind(window);window.fetch=async(url,options)=>{
			if(String(url)!=='/__p2_dev')return original(url,options);
			if(options?.method==='POST')return new Response(JSON.stringify({ok:false,message:'Reload rejected by fixture'}),{status:503,headers:{'Content-Type':'application/json'}});
			window.noticePolls++;return new Response(JSON.stringify({revision:1,phase:'idle',plugins:[],dirty:['chat'],restartNeeded:false,hasLogs:true}),{headers:{'Content-Type':'application/json'}});
		};
	`,
		});
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(
			`document.querySelector('.owner-notice.pending button') && document.querySelector('.composer textarea')`,
		);
		await browser.click(".owner-notice.pending button");
		await browser.wait(
			`document.querySelector('.owner-notice.error')?.textContent.includes('Reload rejected by fixture')`,
		);
		const polls = await browser.evaluate<number>("window.noticePolls");
		await browser.wait(`window.noticePolls>=${polls + 12}`);
		assert(
			await browser.evaluate<boolean>(
				`document.querySelector('.owner-notice.error')?.textContent.includes('Reload rejected by fixture')`,
			),
		);
		await browser.metrics(390, 420);
		assert(
			await browser.evaluate<boolean>(
				`document.querySelector('.owner-notices').getBoundingClientRect().bottom<=document.querySelector('.dock').getBoundingClientRect().top`,
			),
		);
		await browser.evaluate(
			`document.querySelector('.owner-notice.error button[aria-label="Dismiss owner notice"]').scrollIntoView({block:'nearest'})`,
		);
		await browser.click('.owner-notice.error button[aria-label="Dismiss owner notice"]');
		await browser.wait(`!document.querySelector('.owner-notice.error')`);
	},
);

test(
	"native log results are events, while undismissed failures survive page loads",
	{ skip: !browserTests },
	async (t) => {
		const fixture = await startFixture({ web: true });
		t.after(() => fixture.close());
		const browser = await Browser.start();
		await browser.signIn(fixture.owner);
		t.after(() => browser.close());
		await browser.metrics(390, 844);
		const url = `http://127.0.0.1:${fixture.server.port}/new`;
		processLogs.notice("dev", "No dirty plugins");
		await browser.open(url);
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
		// The notices as the server publishes them (Chord's frames are binary: the page's own are not inspected).
		const notices = fixture.browser().hold(LogNotices, {}, BACKGROUND_CONTEXT);
		await until(notices.notices, (rows) => Boolean(rows?.some((row) => row.message === "No dirty plugins")));
		await browser.wait(`document.querySelectorAll('.owner-notice.success').length===0`);
		processLogs.notice("dev", "Restarted server");
		await browser.wait(`document.querySelector('.owner-notice.success')?.textContent.includes('Restarted server')`);
		await browser.open(url);
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
		const failure = "Native notice failure fixture";
		processLogs.notice("dev", failure);
		await browser.wait(
			`document.querySelector('.owner-notice.error')?.textContent.includes(${JSON.stringify(failure)})`,
		);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.owner-notice.success').length`), 0);
		await browser.open(url);
		await browser.wait(
			`document.querySelector('.owner-notice.error')?.textContent.includes(${JSON.stringify(failure)})`,
		);
		const row = (await until(notices.notices, (rows) => Boolean(rows?.some((row) => row.message === failure))))?.find(
			(row) => row.message === failure,
		);
		assert(row);
		await browser.click('.owner-notice.error button[aria-label="Dismiss owner notice"]');
		await browser.wait(`!document.querySelector('.owner-notice.error')`);
		assert.equal(
			await browser.evaluate<string>(
				`localStorage.getItem(${JSON.stringify(`pi-owner-notice-dismissed:log:${row.id}:${row.time}`)})`,
			),
			"1",
		);
		await browser.open(url);
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
		await until(notices.notices, (rows) => !rows?.some((row) => row.message === failure));
		assert.equal(
			await browser.evaluate<number>(
				`document.querySelectorAll('.owner-notice.error,.owner-notice.success').length`,
			),
			0,
		);
		notices.release();
	},
);
