'use strict';
const state = { phase: 1, step: -1, appliedStep: -1, playing: false, busy: false, speed: 1, timer: null, animation: null, epoch: 0 };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const actorNames = { browser: '浏览器', server: '后端进程', pg: 'PostgreSQL', redis: 'Redis' };
const icon = (name, cls = '') => `<i data-lucide="${name}" class="${cls}" aria-hidden="true"></i>`;
const currentPhase = () => demoData.phases[state.phase];
const currentStep = () => currentPhase().steps[state.step];
const valueLabel = value => value === null ? 'NULL' : typeof value === 'object' ? `对象 · ${Object.keys(value).length} 个字段` : String(value);
const pretty = value => typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '暂无数据');

function snapshot(stepIndex = state.appliedStep) {
  const result = demoData.createSeed(currentPhase().seed);
  for (const step of currentPhase().steps.slice(0, stepIndex + 1)) {
    for (const c of step.changes) {
      if (c.store === 'jwt') { result.jwt = c.value; continue; }
      if (c.remove) delete result[c.store][c.key];
      else result[c.store][c.key] = structuredClone(c.value);
    }
  }
  return result;
}
function touched(store, key) {
  return state.appliedStep === state.step && (currentStep()?.changes || []).some(c => c.store === store && (!key || c.key === key));
}
function pairs(values) {
  return `<dl>${values.map(([key, value]) => `<div class="record-pair"><dt>${escapeHTML(key)}</dt><dd>${escapeHTML(valueLabel(value))}</dd></div>`).join('')}</dl>`;
}
function record(id, title, type, content, active = false) {
  return `<button type="button" class="record ${active ? 'is-touched' : ''}" data-inspect="${escapeHTML(id)}" aria-label="查看 ${escapeHTML(title)}"><span class="record-title"><span>${escapeHTML(title)}</span>${icon('expand')}</span><span class="structure">${escapeHTML(type)}</span>${content}</button>`;
}
function renderStorage() {
  const s = snapshot();
  let browser = Object.keys(s.browser).length ? record('browser:all', 'localStorage', 'String · 名称 → 字符串', pairs(Object.entries(s.browser).map(([k,v]) => [k, k === 'auth_user' ? '用户资料 JSON' : k === 'token_expires_at' ? `${v} ms` : v])), touched('browser')) : '<div class="empty">尚无登录数据<br>auth_token、refresh_token、预计到期时间、用户资料都未保存。</div>';
  if (s.browser.auth_token) browser += `<button class="btn w-full" data-variant="outline" data-inspect="browser:jwt">${icon('file-key')} 查看 JWT 载荷</button>`;
  if (Object.keys(s.transient).length) browser += record('transient:all', '页面临时状态', '当前页面内存 · 未存 localStorage', pairs(Object.entries(s.transient)), touched('transient'));
  browser += '<p class="lane-note">原值存这里。JWT 的 exp 管服务端有效期；本地字符串不会自动过期删除。</p>';
  $('browser-data').innerHTML = browser;

  const entries = Object.entries(s.memory), display = entries.length > 7 ? [entries[0], ...entries.slice(-6)] : entries;
  $('server-data').innerHTML = (entries.length ? record('memory:all', '运行中的值', '进程内存 · 对象与字符串', pairs(display), touched('memory')) : '<div class="empty">还没有加载签名密钥。<br>请求临时值在处理过程中产生。</div>') + `<p class="lane-note">签名密钥跨请求使用。其他内容是本次演示请求的临时工作数据${entries.length > 7 ? '，点开查看全部' : ''}。</p>`;
  const userRows = [['id', s.user.id], ['email', s.user.email], ['password_hash', s.user.password_hash], ['role / status', `${s.user.role} / ${s.user.status}`], ['totp_enabled', s.user.totp_enabled], ['last_login_at', s.user.last_login_at ?? 'NULL']];
  $('pg-data').innerHTML = record('pg:users', 'users', '关系表 · 用户 42 的一行', pairs(userRows), touched('user')) +
    record('pg:security_secrets', 'security_secrets', '关系表 · key 唯一，value 为 TEXT', s.pg.jwt_secret ? pairs([['key', 'jwt_secret'], ['value', s.pg.jwt_secret]]) : '<p class="lane-note mt-2">尚无 jwt_secret 这一行</p>', touched('pg', 'jwt_secret')) +
    record('pg:settings', 'settings', '关系表 · 设置名称与字符串值', pairs([['key', 'session_binding_enabled'], ['value', s.pg.session_binding_enabled]])) + '<p class="lane-note">用户表没有 access_token、refresh_token 或独立 token_version 列。</p>';
  let redis = Object.entries(s.redis).map(([key, entry]) => {
    let content;
    if (entry.type === 'Set') {
      content = `<div class="set-members"><span>{</span>${entry.value.map(member => `<span class="member">${escapeHTML(member)}${s.redis[`refresh_token:${member}`] ? '' : ' · 旧'}</span>`).join('')}<span>}</span></div>`;
    } else if (key.startsWith('totp:')) content = pairs([['UserID', entry.value.UserID], ['Email', entry.value.Email]]);
    else content = pairs([['user_id', entry.value.user_id], ['token_version', `${entry.value.token_version} · V1`], ['family_id', entry.value.family_id]]);
    return record(`redis:${key}`, key, entry.type === 'Set' ? 'Set · 无序、不重复的成员' : 'String · value 是 JSON 文本', content + `<p class="ttl">TTL：${escapeHTML(entry.ttl)}</p>`, touched('redis', key));
  }).join('');
  if (!redis) redis = '<div class="empty">尚无会话记录<br>签发后建立 String 主记录与两个 Set 索引。</div>';
  const removed = state.appliedStep === state.step ? (currentStep()?.changes || []).filter(c => c.store === 'redis' && c.remove) : [];
  if (removed.length) redis += `<p class="lane-note">本步已删除：${removed.map(c => escapeHTML(c.key)).join('、')}</p>`;
  $('redis-data').innerHTML = redis + '<p class="lane-note">点 String 查看完整 JSON。Set 里的旧哈希可能保留，有效性要查主记录。TTL 为示意配置。</p>';
  for (const lane of document.querySelectorAll('.lane')) lane.classList.toggle('is-active', currentStep()?.from === lane.dataset.lane || currentStep()?.to === lane.dataset.lane);
  lucide.createIcons();
}
function renderControls() {
  const phase = currentPhase(), last = phase.steps.length - 1;
  $('prev').disabled = state.step < 0;
  $('next').disabled = state.busy || state.step >= last;
  $('play').setAttribute('aria-pressed', String(state.playing));
  $('play').innerHTML = icon(state.playing ? 'pause' : 'play') + `<span>${state.playing ? '暂停' : state.busy ? '继续播放' : state.step === last ? '重新播放' : '播放阶段'}</span>`;
  $('progress-label').textContent = `${Math.max(0,state.step + 1).toString().padStart(2,'0')} / ${phase.steps.length.toString().padStart(2,'0')}${state.busy ? ' · 传输中' : state.step === last ? ' · 完成' : ''}`;
  const percentage = Math.max(0, state.appliedStep + 1) / phase.steps.length * 100;
  $('progress-fill').style.width = `${percentage}%`;
  $('progress').setAttribute('aria-valuenow', String(Math.round(percentage)));
  $('motion-note').textContent = reducedMotion.matches ? '已尊重减少动态效果设置：直接显示数据与步骤' : innerWidth < 1024 ? '窄屏以卡片高亮和文字方向表示数据流' : '连线上的数据包表示本步传输方向';
  lucide.createIcons();
}
function renderNarrative() {
  const focusedStep = document.activeElement.closest('[data-step]')?.dataset.step;
  const phase = currentPhase(), step = currentStep();
  $('step-number').textContent = Math.max(0,state.step + 1).toString().padStart(2,'0');
  $('action-kind').textContent = step ? `${step.kind} · ${actorNames[step.from]} → ${actorNames[step.to]}` : '阶段起点';
  $('action-title').textContent = step?.title || phase.title;
  $('flow-action').textContent = step ? `${actorNames[step.from]} → ${actorNames[step.to]} · ${step.title}` : '从四处存储观察同一份登录身份';
  $('flow-use').textContent = step ? `取出后用途：${step.use}` : '播放一个阶段，数据传输后会更新下面的存储；点记录查看完整字段。';
  $('action-description').textContent = step?.description || phase.start;
  $('action-facts').innerHTML = step ? [['存储结构',step.structure],['取出或生成',step.take],['接着怎么用',step.use]].map(([label, val]) => `<div><dt>${label}</dt><dd>${escapeHTML(val)}</dd></div>`).join('') : '<div><dt>怎样操作</dt><dd>点“播放阶段”连续观看，或点“下一步”逐步观察。点记录可以展开字段和值。</dd></div>';
  $('operation').textContent = step?.operation || 'A1 = access token   R1 = refresh token\nH1 = SHA256(R1)      F1 = 登录会话家族\nV1 / V2 = 计算出的凭据版本示意';
  $('takeaway').textContent = step?.note || phase.note;
  $('steps').innerHTML = phase.steps.map((item, index) => `<li><button class="step-btn" data-step="${index}" ${index === state.step ? 'aria-current="step"' : ''}><span class="num">${String(index+1).padStart(2,'0')}</span><span>${escapeHTML(item.title)}</span>${index <= state.appliedStep ? icon('check','step-check') : ''}</button></li>`).join('');
  if (focusedStep !== undefined) $('steps').querySelector(`[data-step="${focusedStep}"]`)?.focus({preventScroll:true});
  $('announcement').textContent = step ? `${phase.label}，第 ${state.step+1} 步，${step.title}。${state.busy ? '数据传输中' : '已显示本步存储结果'}` : `${phase.label}，阶段起点。`;
}
function renderPhase() {
  const focusedPhase = document.activeElement.closest('[data-phase]')?.dataset.phase;
  $('phases').innerHTML = demoData.phases.map((p,i) => `<button class="btn phase-btn" data-variant="outline" data-phase="${i}" aria-pressed="${state.phase === i}"><span class="phase-num">${String(i+1).padStart(2,'0')}</span>${icon(p.icon)}${escapeHTML(p.label)}</button>`).join('');
  $('phase-index').textContent = `阶段 ${state.phase+1}`;
  $('stage-title').textContent = currentPhase().title;
  $('stage-subtitle').textContent = currentPhase().subtitle;
  $('seed-note').textContent = currentPhase().start;
  renderAll();
  if (focusedPhase !== undefined) $('phases').querySelector(`[data-phase="${focusedPhase}"]`)?.focus({preventScroll:true});
}
function renderAll() { renderNarrative(); renderStorage(); renderControls(); drawRoute(); }
function drawRoute() {
  const step = currentStep(), route = $('route-line');
  if (!step || innerWidth < 1024 || reducedMotion.matches) { route.setAttribute('d',''); return; }
  const box = $('diagram').getBoundingClientRect();
  const a = $(`lane-${step.from}`).getBoundingClientRect(), b = $(`lane-${step.to}`).getBoundingClientRect();
  const x1 = a.x - box.x + a.width/2, x2 = b.x - box.x + b.width/2, y1 = a.y - box.y - 2, y2 = b.y - box.y - 2;
  const d = step.from === step.to ? `M ${x1} ${y1} C ${x1-55} ${y1-64}, ${x1+55} ${y1-64}, ${x1+1} ${y1}` : `M ${x1} ${y1} C ${x1} 10, ${x2} 10, ${x2} ${y2}`;
  route.setAttribute('d',d);
}
function hidePacket() { $('packet').style.opacity = '0'; }
function stopPlayback({ cancelAnimation = false } = {}) {
  state.playing = false; clearTimeout(state.timer); state.timer = null;
  if (cancelAnimation) {
    state.epoch++; state.animation?.stop(); state.animation = null; state.busy = false; hidePacket();
  } else state.animation?.pause();
}
function seek(index) {
  stopPlayback({cancelAnimation:true});
  state.step = Math.max(-1,Math.min(index,currentPhase().steps.length-1)); state.appliedStep = state.step;
  renderAll();
}
function switchPhase(index) {
  stopPlayback({cancelAnimation:true}); state.phase = index; state.step = -1; state.appliedStep = -1;
  $('route-line').setAttribute('d',''); renderPhase();
}
async function animatePacket(epoch) {
  if (reducedMotion.matches || innerWidth < 1024) return;
  const path = $('route-line'), packet = $('packet');
  packet.textContent = currentStep().packet;
  const length = path.getTotalLength(), width = packet.getBoundingClientRect().width, points = Array.from({length:50},(_,i)=>path.getPointAtLength(length*i/49));
  state.animation = Motion.animate(packet, { x:points.map(p=>p.x-width/2), y:points.map(p=>p.y-13), opacity:1 }, { duration:1.25, ease:'linear' });
  state.animation.speed = state.speed;
  try { await state.animation; } catch (_) { /* interrupted animation is superseded by the epoch guard */ }
  if (state.epoch === epoch) { state.animation = null; hidePacket(); }
}
function scheduleNext() {
  clearTimeout(state.timer);
  if (!state.playing || state.busy) return;
  if (state.step >= currentPhase().steps.length-1) { state.playing = false; renderControls(); return; }
  state.timer = setTimeout(() => advance(),2200/state.speed);
}
async function advance() {
  if (state.busy || state.step >= currentPhase().steps.length-1) return;
  clearTimeout(state.timer); const epoch = ++state.epoch;
  state.step++; state.busy = true; renderAll();
  await animatePacket(epoch);
  if (state.epoch !== epoch) return;
  state.appliedStep = state.step; state.busy = false; renderAll(); scheduleNext();
}
function togglePlayback() {
  if (state.playing) { stopPlayback(); renderControls(); return; }
  state.playing = true;
  if (state.busy) { state.animation?.play(); renderControls(); return; }
  if (state.step === currentPhase().steps.length-1) { state.step=-1; state.appliedStep=-1; }
  renderControls(); advance();
}
function jsonBlock(value) { return `<pre class="operation">${escapeHTML(pretty(value))}</pre>`; }
function showInspector(title, description, content) {
  stopPlayback(); renderControls();
  $('inspector-title').textContent=title; $('inspector-description').textContent=description;
  $('inspector-content').innerHTML=content; $('inspector').showModal();
}
function inspect(id) {
  const s=snapshot(), [kind,...rest]=id.split(':'), key=rest.join(':');
  if (kind==='pg') {
    let value = key==='users' ? s.user : key==='security_secrets' ? (s.pg.jwt_secret ? {key:'jwt_secret',value:s.pg.jwt_secret} : '尚无这一行') : {key:'session_binding_enabled',value:s.pg.session_binding_enabled};
    const table = `<table class="inspector-table"><thead><tr><th>字段</th><th>PostgreSQL 类型</th><th>用途</th></tr></thead><tbody>${demoData.schemas[key].map(row=>`<tr>${row.map(cell=>`<td>${escapeHTML(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    showInspector(`PostgreSQL · ${key}`, '按关系表的列保存数据；下面的 JSON 只用于展示当前行，不代表 PostgreSQL 把整行存成 JSON。', table+'<h3 class="mb-3 mt-5 text-sm font-semibold">本步之后的行值</h3>'+jsonBlock(value));
  } else if (kind==='redis') {
    const entry=s.redis[key]; if(!entry)return;
    showInspector(`Redis · ${key}`,entry.type==='String' ? 'Redis 类型是 String。value 是 JSON 序列化文本，GET 之后在后端反序列化。' : 'Redis 类型是 Set。成员是哈希字符串，SMEMBERS 取出成员后用于定位主记录。', `<p class="mb-3 text-sm">TTL：${escapeHTML(entry.ttl)}。它是 key 的属性，不是下面 value 的字段。</p>${jsonBlock(entry.value)}<p class="mt-4 text-xs leading-6 text-subtle">${entry.type==='Set' ? '旧哈希可能仍在集合中。成员没有独立 TTL；添加时重设整个集合的 TTL。' : key.startsWith('totp:') ? 'T1 原值用在临时会话 key 中，JSON 保存等待双重验证的用户；它与刷新会话的哈希规则不同。' : 'refresh token 原值不保存在这份主记录中；哈希在主记录 key 中。'}</p>`);
  } else if (kind==='browser' && key==='jwt') {
    const at=s.browser.auth_token?.startsWith('A2') ? demoData.t+86400000 : demoData.t;
    showInspector('浏览器 · JWT 载荷', 'auth_token 保存整个 JWT 字符串。以下是载荷解码示意，签名不在载荷中。',jsonBlock(demoData.claims(at))+'<p class="mt-4 text-xs leading-6 text-subtle">sid 与 family_id 对应。这里没有密码哈希和系统签名密钥。token_version 数字是示意值。</p>');
  } else {
    const value=kind==='browser'?s.browser:kind==='transient'?s.transient:s.memory;
    showInspector(kind==='browser'?'浏览器 · localStorage':kind==='transient'?'浏览器 · 页面临时状态':'后端 · 当前工作数据',kind==='browser'?'每个存储值实际都是字符串；auth_user 的字符串内容是 JSON。':kind==='transient'?'当前页面的临时值，没有作为正式登录凭据保存。':'这是运行时工作数据，内存对象不意味着数据库存在同名列。',jsonBlock(value));
  }
}

document.addEventListener('click',event=>{
  const phaseButton=event.target.closest('[data-phase]'); if(phaseButton) {switchPhase(Number(phaseButton.dataset.phase));return;}
  const stepButton=event.target.closest('[data-step]'); if(stepButton) {seek(Number(stepButton.dataset.step));return;}
  const recordButton=event.target.closest('[data-inspect]'); if(recordButton) inspect(recordButton.dataset.inspect);
});
$('next').addEventListener('click',()=>{stopPlayback();advance();});
$('prev').addEventListener('click',()=>seek(state.step-1));
$('reset').addEventListener('click',()=>seek(-1));
$('play').addEventListener('click',togglePlayback);
$('speed').addEventListener('change',()=>{state.speed=Number($('speed').value); if(state.animation)state.animation.speed=state.speed; scheduleNext();});
$('close-inspector').addEventListener('click',()=>$('inspector').close());
$('inspector').addEventListener('click',event=>{if(event.target===$('inspector'))$('inspector').close();});
$('sources').addEventListener('click',()=>showInspector('数据结构与源码出处','固定到 3a6fd1c9；所有凭据、密码哈希和版本均为演示值。', `<div class="flex flex-col gap-4 text-sm leading-7"><p><strong>PostgreSQL：</strong>users、security_secrets 和 settings 是关系表。主要按行列读取与更新，不把登录 Token 对写进用户表。</p><p><strong>Redis：</strong>刷新主记录是 String JSON，两个索引是 Set。临时 TOTP 会话也是 String JSON；会话的 TTL 属于 key。</p><p><strong>浏览器：</strong>localStorage 保存凭据原字符串。后端内存保存启动密钥和当前请求工作值。</p><p>动画展示正常串行成功路径；删除失败、索引写入失败与非原子轮换的边界，见对应步骤说明。</p><ul class="flex flex-col gap-2">${demoData.sources.map(source=>`<li><a href="${source.url}" target="_blank" rel="noopener noreferrer">${escapeHTML(source.label)}</a></li>`).join('')}</ul></div>`));
document.addEventListener('keydown',event=>{
  if($('inspector').open || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest('button,a,input,select,textarea'))return;
  if(event.code==='Space') {event.preventDefault();togglePlayback();}
  if(event.key==='ArrowRight') {event.preventDefault();stopPlayback();advance();}
  if(event.key==='ArrowLeft') {event.preventDefault();seek(state.step-1);}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPlayback();renderControls();}});
reducedMotion.addEventListener('change',()=>{seek(state.appliedStep);});
let resizeTimer;
addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.busy)seek(state.appliedStep);else{drawRoute();renderControls();}},100);});
renderPhase();
