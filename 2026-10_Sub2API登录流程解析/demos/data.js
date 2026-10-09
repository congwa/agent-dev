/* The source-backed demonstration model is separate from DOM and playback.
   Every phase has an explicit seed; snapshots replay changes deterministically. */
'use strict';
const demoData = (() => {
  const commit = '3a6fd1c9db07203ca308aaba69e502bc1f35b307';
  const root = `https://github.com/Wei-Shaw/sub2api/blob/${commit}/`;
  const t = Date.parse('2026-10-09T10:00:00+08:00');
  const v1 = 123456789, v2 = 987654321;
  const record = (version = v1, at = t) => ({ user_id: 42, token_version: version, family_id: 'F1', binding_hash: 'B1（IP + User-Agent 指纹示意）', created_at: new Date(at).toISOString(), expires_at: new Date(at + 30 * 86400000).toISOString() });
  const claims = (at = t) => ({ user_id: 42, email: 'user@example.com', role: 'user', token_version: v1, sid: 'F1', bnd: 'B1（示意）', iat: at / 1000, nbf: at / 1000, exp: at / 1000 + 86400 });
  const cache = (hash = 'H1', at = t) => ({ type: 'String', ttl: '30 天', value: record(v1, at) });
  const index = (members) => ({ type: 'Set', ttl: '30 天（最近添加时重设）', value: members });
  const userInfo = { id: 42, email: 'user@example.com', role: 'user', status: 'active' };
  const change = (store, key, value) => ({ store, key, value });
  const remove = (store, key) => ({ store, key, remove: true });
  const M = (key, value) => change('memory', key, value);
  const R = (key, value) => change('redis', key, value);
  const B = (key, value) => change('browser', key, value);
  const U = (key, value) => change('user', key, value);
  const createSeed = (mode = 'empty') => {
    const s = {
      user: { id: 42, email: 'user@example.com', password_hash: '$2a$…密码哈希 V1', role: 'user', status: 'active', totp_enabled: mode === '2fa', totp_secret_encrypted: mode === '2fa' ? 'AES-GCM 密文（示意）' : null, last_login_at: null, last_active_at: null },
      pg: { jwt_secret: mode === 'startup' ? null : 'JWT_KEY（示意）', session_binding_enabled: 'false' },
      memory: mode === 'startup' ? {} : { jwt_secret: 'JWT_KEY（已从数据库加载）' },
      browser: {}, redis: {}, transient: {}, jwt: null
    };
    if (mode === 'auth' || mode === 'rotated') {
      const rotated = mode === 'rotated', hash = rotated ? 'H2' : 'H1', at = rotated ? t + 86400000 : t;
      s.browser = { auth_token: rotated ? 'A2（完整 JWT 的示意名）' : 'A1（完整 JWT 的示意名）', refresh_token: rotated ? 'R2（rt_…原字符串）' : 'R1（rt_…原字符串）', token_expires_at: String(at + 86400000), auth_user: JSON.stringify(userInfo) };
      s.redis = { [`refresh_token:${hash}`]: cache(hash, at), 'user_refresh_tokens:42': index(rotated ? ['H1', 'H2'] : ['H1']), 'token_family:F1': index(rotated ? ['H1', 'H2'] : ['H1']) };
      s.jwt = claims(at); s.user.last_login_at = '2026-10-09 10:00'; s.user.last_active_at = '2026-10-09 10:00';
    }
    return s;
  };
  const step = (title, kind, from, to, packet, description, structure, take, use, operation, note, changes = []) => ({ title, kind, from, to, packet, description, structure, take, use, operation, note, changes });
  const issue = () => [
    step('为本次登录生成会话编号', '生成', 'server', 'server', 'F1 · 会话编号', '后端生成新的家族编号 F1。稍后的 JWT 与刷新会话都引用它，把两张凭据关联到同一次登录。', '后端内存中的字符串', '随机生成的 family_id = F1', '把 F1 写入 JWT 的 sid，同时写入刷新会话 JSON。', 'family_id = 新的随机编号 F1', '会话编号在这里生成，不是 PostgreSQL 用户表的一列。', [M('family_id', 'F1')]),
    step('计算版本并签发 access token', '计算 / 签名', 'server', 'server', 'A1 · JWT', '根据当前邮箱和密码哈希形成版本指纹，装入用户信息与会话编号，再用内存中的系统密钥签名。', 'JWT：载荷 + HS256 签名', '用户 42、当前版本 V1、F1、B1 与到期时间', '生成 A1，日后用于 Authorization 请求头。', 'token_version ← 当前邮箱与密码哈希的指纹\nA1 ← HS256 签名(user_id, role, token_version, sid, exp …)', '数字 V1 是示意值。数据库保存计算材料，没有独立 token_version 列。', [M('token_version', v1), M('access_token', 'A1'), M('binding_hash', 'B1（请求指纹）'), change('jwt', 'value', claims())]),
    step('生成刷新原值并计算哈希', '生成 / 哈希', 'server', 'server', 'R1 → SHA256 → H1', '服务器生成带 rt_ 前缀的随机字符串 R1，然后计算完整原值的 SHA-256，得到 H1。', '后端内存：原值 R1 与哈希 H1', '32 字节随机数据产生的刷新凭据', '用 H1 作为 Redis 主记录 key 的一部分；只把 R1 原值交给浏览器。', 'R1 = "rt_" + 随机字节的十六进制编码\nH1 = SHA256(R1)', 'R1 是随机字符串，不是可解码的 JWT。', [M('refresh_token', 'R1（原值）'), M('token_hash', 'H1 = SHA256(R1)')]),
    step('保存刷新会话的主记录', '写入', 'server', 'redis', 'H1 · JSON 会话', '后端把会话对象序列化成 JSON，通过 SET 存到 Redis，并为这个 key 设置刷新有效期。', 'Redis String，value 是一段 JSON；key 有 TTL', '用户编号、版本、F1、绑定指纹和起止时间', '以后收到 R1，计算 H1，再 GET 这份 JSON，才能决定是否续期。', 'SET refresh_token:H1 <会话 JSON> EX <30天秒数>', '这里使用 String 存 JSON，不是 Redis Hash。JSON 的 expires_at 与 key 的 TTL 是两回事。', [R('refresh_token:H1', cache())]),
    step('建立按用户查找的索引', '写入', 'server', 'redis', 'SADD · 用户 Set', '向用户 42 的集合加入 H1，方便以后找到该用户的刷新主记录。', 'Redis Set：无序、不重复的哈希成员', '集合成员 H1', '批量撤销时 SMEMBERS，逐个拼出主记录 key 再删除。', 'SADD user_refresh_tokens:42 H1\nEXPIRE user_refresh_tokens:42 <30天秒数>', 'Set 只保存哈希，没有 R1 原值或完整会话 JSON。索引写入失败会记日志，主记录签发仍可能成功。', [R('user_refresh_tokens:42', index(['H1']))]),
    step('建立按会话查找的索引', '写入', 'server', 'redis', 'SADD · 家族 Set', '向 F1 的家族集合加入 H1，方便按一次登录清理刷新凭据。', 'Redis Set：这一条登录链的哈希成员', '集合成员 H1', '只撤销 F1 时，读取这个 Set，清理对应的刷新主记录。', 'SADD token_family:F1 H1\nEXPIRE token_family:F1 <30天秒数>', '每次添加成员，会重设整个集合 key 的 TTL；成员没有单独 TTL。', [R('token_family:F1', index(['H1']))]),
    step('把正式凭据对返回浏览器', '传输', 'server', 'browser', 'A1 + R1 · 登录响应', '所有登录条件通过后，浏览器收到 access_token、refresh_token、expires_in、token_type 与用户资料。', 'HTTP JSON 响应；尚未写入 localStorage', 'A1、R1、86400 秒与用户资料', '前端用响应建立登录状态，再保存到本地。', '响应 { access_token: A1, refresh_token: R1,\n       expires_in: 86400, token_type: "Bearer", user: … }', 'JWT 签名密钥和密码哈希不会随登录响应返回。凭据对生成失败时有只返回 access token 的兼容路径。', [change('transient', 'response', 'A1、R1、expires_in 和 user')]),
    step('把四项数据存到浏览器', '写入', 'browser', 'browser', 'localStorage · SET', '前端保存两张凭据原值、用户资料 JSON 和预计到期时间，并安排续期定时器。', 'localStorage：名称 → 字符串', '响应中的凭据对和用户资料', '普通接口读取 auth_token；刷新接口读取 refresh_token；定时器读取 token_expires_at。', 'setItem("auth_token", A1)\nsetItem("refresh_token", R1)\nsetItem("auth_user", JSON.stringify(user))\nsetItem("token_expires_at", 浏览器时间 + expires_in × 1000)', 'localStorage 不会因 Token 到期自动删数据。服务器是否接受 JWT，仍以 exp 和鉴权条件为准。', [B('auth_token', 'A1（完整 JWT 的示意名）'), B('refresh_token', 'R1（rt_…原字符串）'), B('auth_user', JSON.stringify(userInfo)), B('token_expires_at', String(t + 86400000)), remove('transient', 'response')])
  ];
  const phases = [
    { id: 'startup', label: '启动密钥', icon: 'key-round', title: '系统签名密钥，从数据库进入运行内存', subtitle: '启动时只加载一次', seed: 'startup', start: '起点：用户已注册；假设尚未保存 jwt_secret，配置中也未指定密钥。', note: '已有数据库密钥时直接读取；配置与数据库值不同，使用数据库中的持久化值。', steps: [
      step('先找数据库里的系统密钥', '读取', 'server', 'pg', '查询 jwt_secret', '后端启动时按名称查询系统密钥表。每行保存一项系统密钥，这一步先确认有没有已有记录。', 'PostgreSQL security_secrets 关系表', 'key = jwt_secret 对应的行', '存在则使用已有 value；这里的示例还没有这行。', 'SELECT value FROM security_secrets WHERE key = \'jwt_secret\';', '签名密钥是系统级数据，不是每个用户各存一份。'),
      step('读取结果为空', '取出', 'pg', 'server', '没有已有记录', '在本示例中，数据库没有对应行。后端需要生成并持久化密钥，而不是每次登录时临时换一把。', '数据库查询结果：没有记录', '未找到 jwt_secret', '进入生成密钥分支。', '查询结果：not found', '配置里已有有效密钥时会尝试首次保存；这里演示随机生成分支。', [M('lookup_result', '尚无持久化密钥')]),
      step('在后端生成随机密钥', '生成', 'server', 'server', 'JWT_KEY · 随机密钥', '后端生成随机字节并编码成密钥字符串，得到示意值 JWT_KEY。', '后端内存中的字符串', '系统随机源生成的候选密钥', '把候选密钥插入数据库。', 'JWT_KEY ← 32 字节随机数据编码', '页面里的 JWT_KEY 只是示意，不是可用的真实秘密。', [M('candidate_secret', 'JWT_KEY（示意）')]),
      step('把密钥存成一行', '写入', 'server', 'pg', 'INSERT · 密钥行', '数据库保存 key 和 value；key 有唯一约束，并发启动时使用冲突不覆盖的插入方式。', 'security_secrets：key 为 VARCHAR(100)，value 为 TEXT', '一行 { key: jwt_secret, value: JWT_KEY }', '让重启与不同实例能够读取同一个持久化值。', 'INSERT INTO security_secrets (key, value)\nVALUES (\'jwt_secret\', <JWT_KEY>)\nON CONFLICT (key) DO NOTHING;', '已有值不会被这一插入覆盖；插入后还要读取真正保存下来的值。', [change('pg', 'jwt_secret', 'JWT_KEY（示意）')]),
      step('读取最终保存值并加载', '读取 / 使用', 'pg', 'server', 'JWT_KEY → 运行配置', '后端重新读取数据库中的实际密钥，把它设置为运行中的 JWT 签名密钥。', '数据库 TEXT → 后端运行配置', '实际持久化的 JWT_KEY', '后续签发与校验 JWT，都使用内存中的这一值。', 'SELECT value FROM security_secrets WHERE key = \'jwt_secret\';\ncfg.JWT.Secret ← 数据库实际 value', '密钥没有登录 Token 的 TTL，不随登录或续期变化。', [M('jwt_secret', 'JWT_KEY（已从数据库加载）'), remove('memory', 'candidate_secret'), remove('memory', 'lookup_result')])
    ] },
    { id: 'login', label: '密码登录', icon: 'log-in', title: '验证身份，再把两张凭据分开保存', subtitle: '未启用 TOTP 的成功路径', seed: 'empty', start: '起点：用户表已有 bcrypt 密码哈希；后端已加载签名密钥；浏览器和 Redis 尚无登录会话。', note: '登录入口另有请求格式、人机验证与限流检查。这里聚焦身份读取和凭据存取。', steps: [
      step('提交邮箱和密码', '传输', 'browser', 'server', '邮箱 + 输入密码', '用户输入的密码只作为当前登录请求的临时数据，交给后端比对。', 'HTTP 请求体 JSON → 后端临时值', 'email 与 password', '按邮箱查找用户，再做 bcrypt 验证。', 'POST /api/v1/auth/login\n{ email: "user@example.com", password: "用户输入" }', '这个演示不收集密码，也不发送真实网络认证请求。', [M('login_email', 'user@example.com'), M('input_password', '用户输入（临时）')]),
      step('按邮箱读取用户行', '读取', 'server', 'pg', 'SELECT · 用户行', '后端查询 users，拿到当前用户的身份、密码哈希、状态和角色。', 'PostgreSQL users 关系表：一位用户一行', '邮箱对应的用户行', '取得 password_hash，供 bcrypt 与输入密码比对。', '按规范化邮箱查询 users\n取出 id、email、password_hash、role、status …', '不存在的用户与密码不匹配都返回凭据错误；数据库故障另行处理。'),
      step('取出哈希并验证身份', '取出 / 使用', 'pg', 'server', '用户 42 + 密码哈希', '密码哈希从数据库进入后端，后端用 bcrypt 比对输入密码，再检查账号是否 active。', 'VARCHAR 密码哈希 → 后端 User 对象', 'id = 42，password_hash = bcrypt V1，status = active', '密码与状态都通过，才继续检查登录模式和是否需要双重验证。', 'bcrypt.CompareHashAndPassword(数据库哈希, 输入密码)\n检查 user.status == active', '不会解密出原密码。校验服务内部生成过的 JWT 不直接交给浏览器，处理器会继续判断 2FA。', [M('user', userInfo), M('password_hash', '$2a$…密码哈希 V1'), remove('memory', 'input_password')]),
      step('记录本次成功登录时间', '写入', 'server', 'pg', 'UPDATE · 登录时间', '登录条件满足后，后端尝试写入最近登录与活跃时间。', 'users 的 TIMESTAMPTZ 列', '本次成功登录时间', '记录用户的登录活动，随后进入凭据签发。', 'UPDATE users SET last_login_at = NOW(),\nlast_active_at = NOW() WHERE id = 42;', '时间写入是尽力记录；它与 Redis 凭据签发不是一个跨数据库整体事务。', [U('last_login_at', '2026-10-09 10:00'), U('last_active_at', '2026-10-09 10:00')]),
      ...issue()
    ] },
    { id: '2fa', label: '双重验证', icon: 'shield-check', title: '密码通过后，临时会话怎样接上动态码', subtitle: '系统和用户均已启用 TOTP', seed: '2fa', start: '起点：密码已通过；用户启用了 TOTP；还没有向浏览器签发正式凭据。', note: 'TOTP 密钥加密保存在用户行；等待动态码的临时会话保存在 Redis。', steps: [
      step('保存待完成的临时登录', '写入', 'server', 'redis', 'T1 · 5 分钟会话', '生成临时凭证 T1，将用户编号与邮箱保存成等待双重验证的临时会话。', 'Redis String：JSON value，TTL 5 分钟', 'UserID、Email 与 TokenExpiry', '第二次请求用 T1 查回刚刚通过密码的用户。', 'SET totp:login:T1 <临时会话 JSON> EX 300', '临时会话与 refresh_token:H1 是两类记录。T1 不能用于普通接口 JWT 鉴权。', [R('totp:login:T1', { type: 'String', ttl: '5 分钟', value: { UserID: 42, Email: 'user@example.com', TokenExpiry: new Date(t + 300000).toISOString() } })]),
      step('返回临时凭证', '传输', 'server', 'browser', 'requires_2fa + T1', '浏览器收到还需要动态码的结果，不会把它当作正常登录凭据对。', 'HTTP JSON → 页面临时状态', 'requires_2fa = true、temp_token = T1、脱敏邮箱', '显示六位动态码输入，再发第二次请求。', '响应 { requires_2fa: true, temp_token: T1,\n       user_email_masked: "u***@example.com" }', 'T1 保存在本演示的页面临时区，不是 auth_token。', [change('transient', 'temp_token', 'T1（仅页面临时）')]),
      step('把临时凭证与动态码一起送回', '传输', 'browser', 'server', 'T1 + 六位动态码', '用户输入认证器动态码，浏览器把它和临时凭证一起提交。', 'HTTP 请求体 JSON', 'temp_token = T1 与 totp_code', '先查临时会话，确定要验证哪位用户。', 'POST /api/v1/auth/login/2fa\n{ temp_token: T1, totp_code: "六位动态码" }', '源码要求动态码长度为 6；本演示只画流程，不计算实际 TOTP。', [M('temp_token', 'T1')]),
      step('读取临时会话', '读取 / 取出', 'redis', 'server', 'GET · 临时 JSON', '后端用 T1 读取 String 并反序列化，取回用户 42。缺失或过期则不能完成第二步登录。', 'Redis String JSON → TotpLoginSession 对象', '临时会话中的 UserID = 42', '根据用户编号加载 TOTP 用户配置。', 'GET totp:login:T1\nJSON 反序列化 → UserID = 42', 'Redis key 的 TTL 负责让临时会话过期。', [M('user_id', 42)]),
      step('读取加密的 TOTP 密钥', '读取 / 取出', 'pg', 'server', '用户行 · TOTP 密文', '动态码验证服务根据用户编号读取用户，包括已加密的 TOTP 密钥。', 'users.totp_secret_encrypted：TEXT 密文', '加密密钥与 totp_enabled = true', '在后端解密，用密钥校验当前时间窗口的动态码。', '读取用户 42 的 TOTP 配置\n解密密钥 → 校验六位动态码', 'TOTP 密钥在服务端使用，不返回浏览器。', [M('totp_secret', '解密后密钥（仅后端临时）')]),
      step('验证后再次检查当前用户', '读取 / 使用', 'pg', 'server', '当前状态 + 当前角色', '动态码通过后再次加载当前用户，检查 active 状态和登录模式限制。', '当前 users 行 → 后端 User 对象', '当前用户状态和角色', '全部检查通过，才删除临时会话并签发正式凭据。', '动态码通过\n再次读取当前用户并检查状态、模式限制', '这一步防止把此前读取的用户状态当作最终结论。', [M('user', userInfo), M('password_hash', '$2a$…密码哈希 V1'), remove('memory', 'totp_secret')]),
      step('结束临时会话并记录登录', '删除 / 写入', 'server', 'redis', 'DEL · 临时会话', '所有检查通过后尝试删除 T1，并记录成功登录时间，随后进入与普通登录相同的凭据签发段。', 'Redis DEL；PostgreSQL 登录时间列', '已经完成用途的临时会话', '不再用 T1，接下来生成正式 A1 与 R1。', 'DEL totp:login:T1\n记录 users.last_login_at / last_active_at', '删除临时会话与后续凭据签发是分开的操作。', [remove('redis', 'totp:login:T1'), remove('transient', 'temp_token'), U('last_login_at', '2026-10-09 10:00'), U('last_active_at', '2026-10-09 10:00')]),
      ...issue()
    ] },
    { id: 'request', label: '访问接口', icon: 'send', title: '取出 access token，校验后再读当前用户', subtitle: '普通 JWT 鉴权', seed: 'auth', start: '起点：A1、R1 已存入浏览器；Redis 中有 H1 会话与两个 Set。', note: '观察这一阶段：Redis 刷新记录存在，但普通 JWT 鉴权不会读取它。', steps: [
      step('从本地取出 A1', '读取 / 使用', 'browser', 'browser', 'GET · auth_token', '请求拦截器从 localStorage 取出完整 JWT 字符串。', 'localStorage：String', 'auth_token 对应的 A1', '拼成 Bearer 凭据放到请求头。', 'A1 ← localStorage.getItem("auth_token")\nAuthorization: Bearer A1', 'auth_user 是界面资料，不能代替服务端鉴权。'),
      step('带着请求头访问接口', '传输', 'browser', 'server', 'Authorization · A1', '浏览器请求当前用户接口，服务器从 Authorization 中提取 JWT。', 'HTTP Authorization 请求头', '完整 A1 字符串', '检查 Bearer 格式，然后验证签名与时间。', 'GET /api/v1/auth/me\nAuthorization: Bearer A1', '此处发送的是 access token，没有使用 R1。', [M('request_token', 'A1')]),
      step('用内存密钥验证 JWT', '校验', 'server', 'server', '签名 + exp + nbf', '后端使用启动时加载的密钥验证签名，检查到期和最早生效时间，再读取载荷。', 'JWT → JWTClaims 对象', 'user_id = 42、token_version = V1、sid = F1', '用载荷中的用户编号查找当前用户。', '校验 A1 的 HMAC 签名、exp、nbf\n读取 claims.user_id = 42', '解码能看到内容，验签才证明内容可信。JWT 载荷没有密码。', [M('claims', claims())]),
      step('再次查询当前用户', '读取', 'server', 'pg', 'SELECT · id 42', '鉴权服务不会只信签发时的角色与状态，而是按用户编号读取当前数据库行。', 'PostgreSQL users 关系表', '当前邮箱、密码哈希、角色和状态', '计算当前版本并检查用户是否还允许使用。', '按 id = 42 查询当前用户\n读取 email、password_hash、role、status', '正常 JWT 鉴权会查当前用户；不会用 refresh 主记录决定 A1 是否有效。'),
      step('使用当前状态与当前版本', '取出 / 使用', 'pg', 'server', '当前用户 + V1', '后端计算当前凭据版本，与 JWT 签发时版本比较，并确认用户 active。', '数据库行 → 当前 User 与版本指纹', '当前版本 V1，与 JWT 中 V1 一致', '通过后进行可选的 IP / User-Agent 绑定检查。', '当前版本 ← email + password_hash 的指纹\n检查 active 且 claims.token_version == 当前版本', '开启绑定时还要比对指纹；示例 settings 开关为 false。', [M('user', userInfo), M('token_version', v1)]),
      step('把身份放入请求上下文', '使用', 'server', 'server', '身份 → 业务处理', '通过检查后，把用户编号、当前角色、邮箱和会话编号放到请求上下文。业务处理使用这些身份信息。', '后端当前请求的 context', '用户 42、当前角色 user、会话 F1', '执行业务逻辑，返回用户可访问的数据。', 'context ← { user_id: 42, 当前 role, email, sid: F1 }\n进入业务处理', '当前角色来自当前用户行。它不只是 JWT 中的旧角色快照。', [M('auth_context', { user_id: 42, role: 'user', sid: 'F1' })]),
      step('返回结果并更新界面资料', '传输 / 写入', 'server', 'browser', '当前用户资料', '当前用户接口返回资料，前端更新展示用的 auth_user。', '响应 JSON → localStorage String JSON', '最新用户资料', '界面恢复或更新；下一次请求仍要带 A1 鉴权。', '响应当前用户资料\nsetItem("auth_user", JSON.stringify(user))', '整个正常鉴权过程没有 GET refresh_token:H1。', [B('auth_user', JSON.stringify(userInfo))])
    ] },
    { id: 'refresh', label: 'Token 续期', icon: 'refresh-cw', title: '查回刷新会话，换发两张新凭据', subtitle: '成功串行轮换', seed: 'auth', start: '起点：访问凭据接近到期；浏览器持有 A1、R1；Redis 中 H1 主记录仍有效。', note: 'H1 → H2；F1 保持不变。旧 Set 成员不会因此自动移除。', steps: [
      step('从本地取出 R1', '读取', 'browser', 'browser', 'GET · refresh_token', '主动定时器在预计到期前 120 秒尝试续期，普通接口的 401 也可能触发。', 'localStorage：String', '刷新凭据原值 R1', '把 R1 放在刷新请求体，不拿 access token 当刷新凭据。', 'R1 ← localStorage.getItem("refresh_token")', '同页请求共享 Promise；支持 Web Locks 时，多标签页尽量排队。'),
      step('提交刷新原值', '传输', 'browser', 'server', 'R1 · 刷新请求', '后端收到 R1，检查前缀，再计算哈希 H1。', 'HTTP JSON → 哈希 H1', 'refresh_token = R1', '用哈希定位 Redis 主记录。', 'POST /api/v1/auth/refresh\n{ refresh_token: R1 }\nH1 = SHA256(R1)', '刷新路由不先要求普通 JWT 鉴权，仍有自己的凭据与限流检查。', [M('refresh_token', 'R1'), M('token_hash', 'H1')]),
      step('用 H1 查刷新主记录', '读取', 'server', 'redis', 'GET · H1', '后端 GET 哈希对应的 String，不能只查看 Set 中有没有 H1。', 'Redis String：会话 JSON', 'refresh_token:H1 的 value', '反序列化，取出续期检查所需字段。', 'GET refresh_token:H1', '主记录不存在时返回无效凭据。Set 里残留 H1 也无法完成续期。'),
      step('取出会话字段并查当前用户', '取出 / 使用', 'redis', 'server', 'JSON → 会话对象', '从 JSON 取出用户编号、V1、F1、绑定指纹与到期时间。先检查会话时间，再用用户编号查数据库。', 'String JSON → RefreshTokenData 对象', 'user_id = 42、token_version = V1、family_id = F1', '检查 expires_at；按 user_id 读取当前用户。', 'JSON 反序列化\n读取 user_id、token_version、family_id、expires_at', 'JSON 内的到期时间供程序检查，Redis TTL 使主记录过期。', [M('refresh_session', record()), M('family_id', 'F1')]),
      step('读取当前用户并比较版本', '读取 / 使用', 'pg', 'server', '当前用户 + V1', '加载当前用户，检查 active 状态与当前版本；如果启用了绑定，还检查当前请求指纹。', 'PostgreSQL users 行 → 当前版本', '当前用户 42 与当前版本 V1', '与会话中的 V1 匹配，正常进入轮换。', '查当前用户 42\n检查状态、版本与可选绑定', '用户被删除、禁用或版本改变时，会拒绝续期并尝试撤销家族。', [M('user', userInfo), M('token_version', v1)]),
      step('删除旧刷新主记录', '删除', 'server', 'redis', 'DEL · H1', '服务器删除 H1 主记录，使 R1 在正常轮换后不能再次取得会话。两个 Set 中的旧哈希仍保留。', 'Redis DEL：只删除 String 主记录', 'refresh_token:H1', '正常继续生成新的凭据对，家族 F1 不变。', 'DEL refresh_token:H1', '读取、删除、签发不是一次原子消费。删除失败会记日志后继续，不能保证所有故障下旧凭据失效。', [remove('redis', 'refresh_token:H1')]),
      step('生成 A2、R2 和 H2', '生成 / 签名', 'server', 'server', 'A2 + R2 → H2', '重新签发 JWT 和随机刷新凭据，重新计算到期时间，继续使用 F1。', '后端内存：新 JWT、原值、哈希', 'A2、R2、H2；版本仍为 V1', '把 H2 的新会话存入 Redis，再返回两张新凭据。', 'A2 ← 新签发 JWT，sid 仍为 F1\nR2 ← 新随机字符串；H2 = SHA256(R2)', '每次成功续期都重新计时。若旧记录已删而新签发失败，会出现旧凭据失效但没有拿到新凭据的窗口。', [M('access_token', 'A2'), M('refresh_token', 'R2'), M('token_hash', 'H2'), change('jwt', 'value', claims(t + 86400000))]),
      step('写入 H2 主记录', '写入', 'server', 'redis', 'SET · H2 JSON', '主记录保存新时间，用户编号、F1 与当前版本保持对应关系。', 'Redis String JSON，新的 30 天 TTL', '新会话的 created_at、expires_at', '下一次使用 R2 时，通过 H2 找到这份主记录。', 'SET refresh_token:H2 <新会话 JSON> EX <30天秒数>', '默认刷新有效期是 30 天，具体部署可以覆盖。', [R('refresh_token:H2', cache('H2', t + 86400000))]),
      step('向两个索引加入 H2', '写入', 'server', 'redis', 'SADD · H2', '向用户集合和 F1 集合各加入 H2，并重设整个集合的 TTL。', '两个 Redis Set', '成员从 {H1} 变为 {H1, H2}', '后续按用户或家族清理时，能找到新主记录。', 'SADD user_refresh_tokens:42 H2\nSADD token_family:F1 H2\n分别重设两个集合 key 的 TTL', 'H1 留在 Set；H1 主记录已删。索引成员不等于有效会话。', [R('user_refresh_tokens:42', index(['H1', 'H2'])), R('token_family:F1', index(['H1', 'H2']))]),
      step('把新凭据对交给浏览器', '传输', 'server', 'browser', 'A2 + R2 · 响应', '刷新响应返回 A2、R2 和访问有效期，浏览器确认请求期间会话没有被换掉。', 'HTTP JSON 响应', '新 access_token 与 refresh_token', '替换本地凭据，并安排下一次续期。', '响应 { access_token: A2, refresh_token: R2, expires_in: 86400 }', '不会返回用户密码哈希或系统签名密钥。', [change('transient', 'response', 'A2、R2、expires_in')]),
      step('保存新凭据并重试请求', '写入 / 使用', 'browser', 'browser', 'localStorage · 替换', '前端先保存 A2 和预计到期时间，最后保存 R2，把它的变化作为新结果写入的标志。', 'localStorage：替换字符串', 'A2、R2 和新预计到期时间', '若由 401 触发，使用 A2 重试原请求一次；然后安排后续续期。', 'setItem("auth_token", A2)\nsetItem("token_expires_at", 新预计到期时间)\nsetItem("refresh_token", R2)  // 最后写\nAuthorization: Bearer A2', '只替换 A1 而保留 R1，会在下一次续期继续使用已轮换的旧凭据。', [B('auth_token', 'A2（完整 JWT 的示意名）'), B('refresh_token', 'R2（rt_…原字符串）'), B('token_expires_at', String(t + 2 * 86400000)), remove('transient', 'response')])
    ] },
    { id: 'logout', label: '退出登录', icon: 'log-out', title: '删除刷新资格，清理浏览器登录状态', subtitle: '正常退出路径', seed: 'rotated', start: '起点：已经续期；浏览器持有 A2、R2；Redis 有 H2 主记录，两个 Set 含 H1、H2。', note: '注意区分：浏览器清理、刷新凭据撤销、JWT 是否立即失效。', steps: [
      step('取出 R2 发起退出', '读取 / 传输', 'browser', 'server', 'R2 · 退出请求', '前端尝试把当前刷新原值交给服务器，撤销它的续期资格。', 'localStorage String → HTTP JSON', '当前 refresh_token = R2', '服务器计算 H2，定位应删除的主记录。', 'POST /api/v1/auth/logout\n{ refresh_token: R2 }', '退出接口不要求普通 JWT 鉴权，刷新原值是可选请求字段。', [M('token_hash', 'H2')]),
      step('删除 H2 主记录', '删除', 'server', 'redis', 'DEL · H2', '正常成功时只删除当前刷新主记录。用户表、签名密钥和两个 Set 不会随普通退出清空。', 'Redis DEL：String 主记录', 'refresh_token:H2', '后续拿 R2 请求刷新时，无法再 GET 到会话。', 'DEL refresh_token:H2', '服务端撤销失败可能仅记录日志；成功提示不能替代真实删除状态检查。', [remove('redis', 'refresh_token:H2')]),
      step('浏览器清理四项本地数据', '删除', 'browser', 'browser', 'removeItem · 清理', '不论退出网络请求成功与否，前端最终清理本地凭据、资料和刷新定时器。', 'localStorage 删除名称 + 清理内存定时器', '本地的 A2、R2、auth_user 与预计到期时间', '界面进入未登录状态，不再拿这些数据发请求。', 'removeItem("auth_token")\nremoveItem("refresh_token")\nremoveItem("auth_user")\nremoveItem("token_expires_at")\n停止刷新定时器', '本地退出成功，不代表服务端刷新撤销一定成功。', ['auth_token', 'refresh_token', 'auth_user', 'token_expires_at'].map(k => remove('browser', k))),
      step('查看仍被另行保留的 A2', '使用边界', 'server', 'server', 'A2 · 仍可能有效', '若 A2 曾被另行复制，删除 H2 不会改变它的签名与 exp。普通鉴权不读取 H2，仍按签名、当前用户、版本与可选绑定检查。', 'JWT；不是 Redis 主记录', '另行保留的 A2，不在已清理的浏览器里', '在到期或其他条件失效前，仍可能通过鉴权。', '普通鉴权不查询 refresh_token:H2\nA2 是否有效由 exp、用户状态、版本和绑定决定', '退出不等于立即注销已经签发的 JWT。这是流程边界，不是动画漏掉了删除。', [M('access_boundary', '另行保留的 A2 仍可能有效')])
    ] },
    { id: 'password', label: '修改密码', icon: 'lock-keyhole', title: '更新密码哈希，旧版本怎样被拒绝', subtitle: '当前用户已完成请求鉴权', seed: 'rotated', start: '起点：A2 与 H2 会话记录的版本都是 V1；当前数据库密码哈希也是 V1 的计算材料。', note: '本阶段展示通过旧密码校验后的持久化更新与后续凭据检查。', steps: [
      step('读取用户并验证当前密码', '读取 / 使用', 'pg', 'server', 'bcrypt 哈希 V1', '修改密码服务先读取当前用户，用现有 bcrypt 哈希验证用户输入的当前密码。', 'users.password_hash：VARCHAR(255)', '当前密码哈希与用户输入', '通过后生成新密码的 bcrypt 哈希。', '读取 users 中用户 42\nbcrypt 比对当前密码', '修改密码接口的 JWT 鉴权发生在这之前，这里从改密服务内部开始。', [M('user', userInfo), M('password_hash', '$2a$…密码哈希 V1')]),
      step('生成新密码哈希', '计算', 'server', 'server', '新 bcrypt 哈希', '对新密码做 bcrypt，得到不同的持久化计算材料。', '后端内存中的新 password_hash', '新密码的 bcrypt 哈希', '只将密码哈希列写回用户表。', '新 password_hash ← bcrypt(新密码)', '内存对象的 TokenVersion 自增不等于数据库新增了版本列。', [M('new_password_hash', '$2a$…新密码哈希 V2')]),
      step('更新用户的密码哈希列', '写入', 'server', 'pg', 'UPDATE · password_hash', '数据库保存新哈希。后续加载用户时，会基于新的邮箱与密码哈希材料计算当前版本。', 'users 行的 password_hash 列', '新 bcrypt 哈希', '当前版本变成示意值 V2；旧 JWT 和旧会话仍保存 V1。', 'UPDATE users SET password_hash = <新哈希> WHERE id = 42;', '没有写入独立 token_version 列。Redis 的旧刷新主记录此时可以仍然存在。', [U('password_hash', '$2a$…新密码哈希 V2'), M('token_version', v2)]),
      step('旧 A2 再访问接口', '传输', 'browser', 'server', 'A2 · 版本 V1', '浏览器还拿着原来的 JWT 发请求，JWT 自身内容并没有因改密被改写。', 'Authorization 请求头 → 旧 JWTClaims', 'A2 中的 token_version = V1', '服务端重新加载当前用户，不能只看签名和到期时间。', 'Authorization: Bearer A2\nclaims.token_version = V1', 'JWT 尚未到期，也可能因为版本检查失效。', [M('claims_version', v1)]),
      step('读出新材料并计算 V2', '读取 / 使用', 'pg', 'server', '当前版本 V2', '当前用户行已经是新密码哈希。后端计算出 V2，与 A2 中 V1 比较。', '当前用户行 → 运行时版本', 'V2，与签发时 V1 不同', '拒绝旧访问凭据，返回 TOKEN_REVOKED。', '当前版本 ← 当前 email + 新 password_hash 的指纹\nV1 != V2 → 401 TOKEN_REVOKED', '跨进程生效的是持久化密码哈希变化。', [M('token_version', v2), M('auth_result', '401 TOKEN_REVOKED')]),
      step('取回旧刷新会话的 V1', '读取 / 使用', 'redis', 'server', 'H2 · 会话版本 V1', '若前端尝试用 R2 续期，后端 GET H2，并在重新加载用户后同样比较版本。', 'Redis String JSON 中的 token_version', '旧会话 V1，当前用户版本 V2', '版本不一致，拒绝续期并尝试撤销 F1。', 'GET refresh_token:H2\n读取当前用户\n会话版本 V1 != 当前版本 V2', '主记录仍在，并不意味着一定能续期；它还要通过用户和版本检查。', [M('refresh_session', record(v1, t + 86400000))]),
      step('按家族 Set 清理主记录', '读取 / 删除', 'server', 'redis', 'SMEMBERS → DEL', '读取 F1 的 Set，取出 H1、H2，拼出对应主记录 key，逐个删除，再删除家族集合。', 'Redis Set 读成员 → DEL String 与家族 Set', 'F1 中的哈希列表 H1、H2', '清理这一条会话链，拒绝返回新的凭据。', 'SMEMBERS token_family:F1 → H1, H2\nDEL refresh_token:H1\nDEL refresh_token:H2\nDEL token_family:F1', '用户集合可能仍留有旧哈希。批量清理是尽力执行，版本比较已经阻止旧会话续期。', [remove('redis', 'refresh_token:H2'), remove('redis', 'token_family:F1')]),
      step('前端结束失效会话', '传输 / 删除', 'server', 'browser', '401 · 重新登录', '刷新被明确拒绝后，前端清理本地登录状态，提示重新登录。', '错误响应 → 本地清理', '版本已失效，无法换发新凭据', '用户重新输入新密码完成新的登录。', '刷新拒绝 → 清理本地凭据 → 返回登录页', '网络故障、限流和服务端暂时错误，与明确凭据失效的处理不同。', ['auth_token', 'refresh_token', 'auth_user', 'token_expires_at'].map(k => remove('browser', k)))
    ] }
  ];
  const schemas = {
    users: [['id', 'BIGINT 主键', '用户编号'], ['email', 'VARCHAR(255)', '登录邮箱 / 版本材料'], ['password_hash', 'VARCHAR(255)', 'bcrypt 哈希 / 版本材料'], ['role', 'VARCHAR(20)', '当前角色'], ['status', 'VARCHAR(20)', '当前账号状态'], ['totp_enabled', 'BOOLEAN', '是否启用 TOTP'], ['totp_secret_encrypted', 'TEXT，可空', 'TOTP 加密密钥'], ['last_login_at', 'TIMESTAMPTZ，可空', '成功登录时间'], ['last_active_at', 'TIMESTAMPTZ，可空', '最近活跃时间']],
    security_secrets: [['id', 'BIGSERIAL 主键', '记录编号'], ['key', 'VARCHAR(100)，UNIQUE', '系统密钥名'], ['value', 'TEXT', '密钥内容'], ['created_at / updated_at', 'TIMESTAMPTZ', '维护时间']],
    settings: [['key', 'VARCHAR(100) UNIQUE', '设置名称'], ['value', 'TEXT', '字符串形式的设置值'], ['updated_at', 'TIMESTAMPTZ', '最近更新时间']]
  };
  const sources = [
    ['登录、2FA、退出处理器', 'backend/internal/handler/auth_handler.go#L237-L420'],
    ['JWT 构建、刷新轮换与版本计算', 'backend/internal/service/auth_service.go#L1689-L1931'],
    ['Redis String 与 Set 实现', 'backend/internal/repository/refresh_token_cache.go#L13-L158'],
    ['用户关系表字段', 'backend/ent/schema/user.go#L39-L116'],
    ['功能开关关系表字段', 'backend/ent/schema/setting.go#L32-L47'],
    ['系统密钥表与加载逻辑', 'backend/internal/repository/security_secret_bootstrap.go#L21-L128'],
    ['普通接口鉴权', 'backend/internal/server/middleware/jwt_auth.go#L38-L115'],
    ['TOTP 临时会话 String', 'backend/internal/repository/totp_cache.go#L72-L110'],
    ['浏览器存储与主动续期', 'frontend/src/stores/auth.ts#L105-L329'],
    ['多标签页刷新协调', 'frontend/src/api/tokenRefresh.ts#L50-L229']
  ].map(([label, path]) => ({ label, url: root + path }));
  return { phases, schemas, sources, createSeed, v1, v2, claims, userInfo, t };
})();
