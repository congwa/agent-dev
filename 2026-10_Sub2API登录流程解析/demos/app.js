/* 中文教学页面：demoData 是唯一的示例材料；state 是唯一的演示步骤状态。
   这里没有认证请求，也不向 localStorage 写入凭据。数据柜只是页面中的图。
   把讲解数据、业务步骤和 DOM 渲染分开，以后可替换成 React 的渲染层。 */
(() => {
  'use strict';
  const d = window.demoData;
  const state = { step: 0 };
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const short = text => text.length > 25 ? text.slice(0, 12) + '…' + text.slice(-8) : text;
  const code = text => `<pre>${escape(text)}</pre>`;
  const userJSON = JSON.stringify({ id: d.id, email: d.email, role: 'user', status: 'active' }, null, 2);
  const mainKey = pair => 'refresh_token:' + pair.hash;
  const familyKey = 'token_family:' + d.family;
  const userKey = 'user_refresh_tokens:42';

  // 每一步只突出一个动作。“token_version”和“token_hash”是两个不同的值，不能互换。
  const steps = [
    {
      title: '读取已有的 users 资料', actor: '注册时 → PostgreSQL', chapter: '第一段：登录',
      body: '小明以前注册过账号。服务器已经给他分配了用户编号 42，并保存了邮箱和“密码哈希”。这次登录是来证明：输入密码的人，就是这个账号的主人。',
      purpose: '如果服务器从来没有存过小明，就没办法知道该拿谁的资料来核对。',
      value: ['user_id', '42', '代码里叫 id；写进 access_token 和 Redis 记录时叫 user_id。'],
      origin: '注册账号时，由数据库分配。42 只是本例的编号。',
      destination: 'PostgreSQL 的 users 表，小明这一行的 id 列。',
      use: '以后 access_token 里带着 42，服务器就能准确查回小明这一行。',
      raw: 'users 表中的一行（只列本故事涉及的资料）：\n' + userJSON + '\npassword_hash = ' + d.passwordHash + '\n\n系统启动时，还把 security_secrets 表的 jwt_secret 读到后端内存。', changed: ['pg']
    },
    {
      title: '用 email 和 password 完成登录校验', actor: '浏览器 → 服务器', chapter: '第一段：登录',
      body: '小明在登录框输入邮箱和密码，浏览器把它们发给服务器。服务器按邮箱找到小明的资料，再用 bcrypt 核对输入的密码是否匹配已保存的密码哈希，并检查账号是否可用。',
      purpose: '先确认是账号的主人，才能签发 token。密码不对或账号被停用，就停在这里。',
      value: ['email / password', d.email, '本次输入的密码只用于核对，不会成为 access_token。'],
      origin: '小明在表单里输入；数据库里的密码哈希来自以前注册或改密时。',
      destination: '输入值通过请求暂时到后端内存；已有密码哈希仍保存在 users.password_hash。',
      use: 'bcrypt 拿本次密码与已有哈希比对。它不会把数据库哈希解密成原密码。',
      raw: 'POST /api/v1/auth/login\n请求体：email、password\n\n1. 按 email 读取 users\n2. bcrypt.CompareHashAndPassword(已存哈希, 本次密码)\n3. 检查当前 status = active\n\n密码哈希是 bcrypt 结果，通常包含算法信息、成本、盐和结果。\n输入的明文密码不写进 users、不写进 Redis，也不作为登录凭据存入 localStorage。', changed: ['server']
    },
    {
      title: '计算 token_version', actor: '服务器的后端内存', chapter: '第一段：登录',
      body: '服务器拿刚读出来的邮箱和密码哈希，算出一个数字。我们叫它“token_version”。以后有人改了密码，数据库里的密码哈希改变，算出来的标记也会改变。',
      purpose: '让服务器能认出“这个 token 携带的是旧 token_version”，不用等旧 token自然到期。',
      value: ['token_version', d.version, '真实字段名：token_version。它不是第几次续期的次数。'],
      origin: '来自数据库里的 email + password_hash，由后端计算。',
      destination: '现在只在后端内存；接下来会放入 access_token 和 Redis refresh_token 记录。数据库没有单独的 token_version 列。',
      use: '每次使用 token时重新算当前标记，与 access_token 或 Redis 记录里旧的标记比较；不一样就拒绝。',
      raw: '材料 = lower(trim(email)) + "\\n" + password_hash\nsum = SHA256(材料的 UTF-8 字节)\nfingerprint = sum 前 8 字节按大端转整数，去掉最高符号位\ntoken_version = 内存中的基础 TokenVersion XOR fingerprint\n\n普通数据库加载的基础值为 0，所以通常就是 fingerprint。\n已解析的用户对象直接复用已解析版本。\n\n本例计算结果：' + d.version + '\n保存材料的地方：users.email、users.password_hash\n保存计算结果的地方：JWT.token_version、Redis JSON.token_version', changed: ['server']
    },
    {
      title: '生成 family_id', actor: '服务器的后端内存', chapter: '第一段：登录',
      body: '小明这一次登录，以后可能续期很多次。服务器给这条登录链起一个随机 family_id，让它们都属于同一组。另一次登录，会得到另一个 family_id。',
      purpose: '以后想撤销这一条登录链时，可以一次找到这一组的 refresh_token 记录。',
      value: ['family_id', short(d.family), '真实字段名：family_id；access_token 内部同一个值叫 sid。'],
      origin: '服务器安全随机生成 16 字节，再转成 32 位十六进制文字。不是由密码算出来的。',
      destination: '现在在后端内存；稍后写进 JWT 的 sid、Redis 档案的 family_id，以及token_family Set的键名。',
      use: '同一次登录续期时沿用它；重新登录会起新 family_id。它不是用户编号，也不是设备硬件编号。',
      raw: 'family_id = hex(安全随机的 16 字节)\n本例完整 family_id：' + d.family + '\n\n后续三个位置：\n1. JWT 载荷的 sid\n2. Redis 主档案 JSON 的 family_id\n3. Redis 键名 token_family:' + d.family, changed: ['server']
    },
    {
      title: '生成 access_token', actor: '服务器的后端内存', chapter: '第一段：登录',
      body: '服务器把“用户 42、token_version、family_id、到期时间”等资料写入 JWT 载荷，再用系统签名密钥签名。签名后的完整 JWT 字符串就是 access_token。',
      purpose: '后续查看资料、调用接口时，请求携带 access_token，服务器就可以验证身份。',
      value: ['access_token', short(d.old.access), 'access_token 是完整长字符串；里面已经包含 token_version 和 family_id。'],
      origin: '用户资料 + 之前两步的标记、family_id + 当前时间 + 系统签名密钥，由服务器制作。',
      destination: '现在在后端内存；登录响应会把它交给浏览器，保存到 localStorage 的 auth_token。',
      use: '浏览器每次请求带上它；服务器验签、查到期时间，再查最新的用户状态与 token_version。',
      raw: 'JWT 的内容（载荷）：\n' + d.old.claimsJSON + '\n\n签名：HS256，用后端内存中的 jwt_secret。\n密钥长期保存在 PostgreSQL security_secrets.value（key = jwt_secret）。\n\nJWT 原值 = Base64URL(头部) + "." + Base64URL(载荷) + "." + Base64URL(签名)\n本例完整原值：\n' + d.old.access + '\n\n注意：JWT 内容可解码阅读，不是加密的密码保险箱。签名用于检查是否被篡改。', changed: ['server']
    },
    {
      title: '生成 refresh_token', actor: '服务器的后端内存', chapter: '第一段：登录',
      body: 'access_token 会到期。服务器再随机生成 refresh_token。小明以后把它交回来，服务器检查通过后，就给他新 access_token 和新 refresh_token。',
      purpose: 'access_token 快到期时，通常不必让小明再次输入密码。',
      value: ['refresh_token', short(d.old.raw), '真实名字：refresh_token。它是随机字符串，里面没有用户编号或 token_version。'],
      origin: '服务器安全随机生成 32 字节，转成 64 位十六进制文字，再在前面加 rt_。',
      destination: '现在在后端内存；稍后交给浏览器，保存到 localStorage 的 refresh_token。Redis 不存这个原值。',
      use: '只拿它调用续期 / 退出接口；普通业务接口用 access_token。',
      raw: 'refresh_token = "rt_" + hex(安全随机的 32 字节)\n长度：3 + 64 = 67 个字符\n本例完整原值：\n' + d.old.raw + '\n\n本例的重复字节只为好认；实际系统不会用这个固定样本。', changed: ['server']
    },
    {
      title: '计算 token_hash', actor: '服务器的后端内存', chapter: '第一段：登录',
      body: '服务器把完整 refresh_token 放进 SHA-256 这个“指纹计算器”，得到固定的 token_hash。同一个 refresh_token 每次算出的 token_hash 相同；新 refresh_token 会产生新的 token_hash。',
      purpose: '以后收到 refresh_token，服务器再算一次这个码，就能找到对应档案；Redis 不用保存能直接拿来续期的 refresh_token 原值。',
      value: ['token_hash', short(d.old.hash), '代码里的 tokenHash / token_hash；它与 refresh_token 原值不同。'],
      origin: '输入是上一页完整的 refresh_token，包括 rt_；输出是 SHA-256 哈希的十六进制文字。',
      destination: '现在在后端内存；接下来放进 Redis 主档案的键名，以及两个名单的成员。',
      use: '用“refresh_token: + token_hash”定位档案。token_hash 本身不是新 access_token 和 refresh_token，不能代替 refresh_token 原值。',
      raw: '输入（完整 refresh_token）：\n' + d.old.raw + '\n\n计算：hex(SHA256(完整 refresh_token 的 UTF-8 字节))\n输出（完整 token_hash）：\n' + d.old.hash + '\n\nRedis 主档案的键名：\n' + mainKey(d.old) + '\n\n不是随机生成第二个码；是用 refresh_token 原值确定地算出来的。', changed: ['server']
    },
    {
      title: '写入 Redis 主记录和两个 Set', actor: '服务器 → Redis', chapter: '第一段：登录',
      body: '服务器把“这个 refresh_token 属于谁、用的是哪套密码、属于哪个登录组、什么时候到期”写进一份档案。档案用 token_hash 当地址；另外把这个码写进user_refresh_tokens Set和token_family Set。',
      purpose: '续期时要有档案可以检查；以后批量撤销时，要有名单可以找到档案。',
      value: ['Redis 的三个 key', '档案：String　名单：Set', 'String 保存一整段 JSON 文字；Set 保存不重复的 token_hash。'],
      origin: '用户编号来自数据库；标记、family_id 来自前面的步骤；创建时间来自服务器时钟；到期时间 = 创建时间 + 配置的 30 天。',
      destination: '全部在 Redis。档案的 token_hash 位于键名，档案内容里没有 refresh_token 原值。两个 Set的成员也只是 token_hash。',
      use: '正常续期读主档案；批量撤销读名单，再按每个 token_hash 找到并删除主档案。名单成员存在，不代表资格仍有效。',
      raw: '// 1. 主档案：SET 写入 String（内容为 JSON），TTL = 30 天\n键：' + mainKey(d.old) + '\n值：\n' + d.old.recordJSON + '\n\n// 2. user_refresh_tokens Set：同一个人的所有登录\nSADD ' + userKey + ' ' + d.old.hash + '\nEXPIRE ' + userKey + ' 2592000\n\n// 3. token_family Set：这一次登录的续期链\nSADD ' + familyKey + ' ' + d.old.hash + '\nEXPIRE ' + familyKey + ' 2592000\n\n2592000 秒 = 30 天。TTL 设在整个 key 上；Set 成员没有单独 TTL。', changed: ['redis']
    },
    {
      title: '浏览器保存登录响应', actor: '服务器 → 浏览器', chapter: '第一段：登录',
      body: '登录响应带回 access_token、refresh_token、用户资料和 access_token 能用多少秒。浏览器把它们收进 localStorage。后续请求和续期就能读取这些值。',
      purpose: '下次发请求或续期，浏览器能从 localStorage 读取相应 token。',
      value: ['localStorage 的四个 key', 'access_token · refresh_token · 资料 · 到期提醒', 'token_version 在 access_token 里面；浏览器没有另存一份 token_version 或 token_hash。'],
      origin: 'access_token 和 refresh_token 由服务器生成；用户资料来自数据库；有效秒数 expires_in 来自服务器的访问有效期配置。',
      destination: 'auth_token = access_token；refresh_token = refresh_token；auth_user = 资料 JSON 字符串；token_expires_at = 前端算出的到期时间（毫秒字符串）。',
      use: '资料供页面显示；access_token 供接口鉴权；refresh_token 供续期；到期时间供前端安排续期提醒。',
      raw: 'localStorage["auth_token"] = 完整 access_token\nlocalStorage["refresh_token"] = 完整 refresh_token\nlocalStorage["auth_user"] = JSON.stringify(返回的用户资料)\nlocalStorage["token_expires_at"] = String(Date.now() + expires_in * 1000)\n\n本例 expires_in = 86400 秒（24 小时）。\n本例假设浏览器在 10:00 收到响应，到期提醒值 = ' + d.old.browserExpiry + '\n这不是 Redis TTL，也不是数据库字段。实际时间取决于前端收到响应的时刻。\n\n登录流程还尝试更新 users.last_login_at / last_active_at；不会把 access_token 和 refresh_token 存到 users 表。', changed: ['browser','pg']
    },
    {
      title: '请求接口时携带 access_token', actor: '浏览器 → 服务器 → PostgreSQL', chapter: '第二段：使用',
      body: '浏览器取出 access_token，随接口请求交给服务器。服务器先验签和有效时间，再按 access_token 里的用户编号 42 查最新账号资料，确认账号可用、token_version 没变，才放行。',
      purpose: '不能只看“浏览器里还有 access_token”就相信它；每次请求都要重新检查。',
      value: ['Authorization 请求头', 'Authorization: Bearer access_token 原值', 'Bearer 是请求头的写法，后面有一个空格；它不是 access_token 原值的一部分。'],
      origin: 'access_token 从 localStorage.auth_token 取出；验签密钥从后端内存取出；当前用户资料从 PostgreSQL 读取。',
      destination: 'access_token 随请求暂时到后端内存，原来的各处存储仍在。普通 JWT 鉴权不需要读 Redis 续期主档案。',
      use: '比较“access_token 里的 token_version”与“根据最新数据库资料算出的 token_version”；业务权限采用数据库中的当前角色。',
      raw: '1. 读取 Authorization: Bearer <完整 JWT>\n2. 使用 jwt_secret 验证 HS256 签名\n3. 检查 exp（到期）、nbf（何时开始有效）\n4. 按 user_id = 42 查当前用户\n5. 检查 status、比较 token_version\n6. 用当前用户身份 / 当前 role 执行业务\n\n可选绑定校验见下方说明。普通鉴权不会因 refresh_token 的 Redis 档案被删除而直接拒绝 JWT。', changed: ['server']
    },
    {
      title: '续期时用 refresh_token 查 Redis', actor: '浏览器 → 服务器 → Redis', chapter: '第三段：续期',
      body: '到了第二天 09:58，前端尝试续期。它取出 refresh_token 发给服务器。服务器再算 token_hash，找到 Redis 旧档案，然后按档案里的用户编号查账号、比较 token_version、检查期限。',
      purpose: '先确认这个 refresh_token 仍有续期资格，才能签发新的 access_token 和 refresh_token。查不到档案、过期或账号检查不通过，就拒绝。',
      value: ['旧 refresh_token 的 token_hash', short(d.old.hash), '因为收到的是同一个 refresh_token 原值，所以算出的 token_hash 还是同一个。'],
      origin: 'refresh_token 原值从浏览器取出；token_hash 重新计算；用户编号、旧 token_version、family_id 和期限从 Redis 档案取出。',
      destination: '读出的档案与当前账号资料暂存在后端内存，接下来要用它们做轮换。',
      use: 'expires_at 决定档案是否过期；user_id 查账号；token_version 比较密码；family_id 留给新 access_token 和 refresh_token 沿用。',
      raw: 'POST /api/v1/auth/refresh\n请求体：{ "refresh_token": "' + d.old.raw + '" }\n\n检查 rt_ 前缀 → 计算 SHA-256 token_hash → GET：\n' + mainKey(d.old) + '\n\n解析档案 JSON，检查 expires_at。\n按 user_id 查 PostgreSQL，检查当前状态 / token_version。\n通过后才进行下一步。', changed: ['server']
    },
    {
      title: '删除旧 refresh_token 主记录', actor: '服务器 → Redis', chapter: '第三段：续期',
      body: '核对通过后，服务器在 Redis 删除旧 token_hash 对应的那一份主档案。这就是“删除旧 refresh_token 主记录”。删的是 Redis 里的档案，不是数据库里的用户，也不是直接删小明浏览器里的字符串。',
      purpose: '正常删除成功后，旧 refresh_token 再来续期时就查不到档案，避免它反复领新 access_token 和 refresh_token。',
      value: ['refresh_token:旧 token_hash', '旧 refresh_token 的 token_hash 对应的主记录', '一个 Redis String key；只删除这个 refresh_token 的主记录。'],
      origin: '上一页已经算出了旧 refresh_token 的 token_hash；在前面加 refresh_token: 就得到要删除的键名。',
      destination: '旧主档案从 Redis 消失；浏览器仍暂时拿着旧 access_token 和 refresh_token，两个 Set 也仍可能留着旧 token_hash。',
      use: '下一步发新 access_token 和 refresh_token、存新档案。旧名单成员不会让被删的档案复活。',
      raw: 'DEL ' + mainKey(d.old) + '\n\n执行的是 Redis DEL，不是 SQL DELETE。\n删除前：GET 旧键 → 一段档案 JSON\n正常删除后：GET 旧键 → 找不到\n\n源码没有在这里 SREM 两个 Set中的旧成员。\n且读、删、发新 access_token 和 refresh_token 为分开的操作；删除失败会记日志并继续，不能当成原子消费保证。', changed: ['redis']
    },
    {
      title: '生成新 access_token 和 refresh_token 并写入 Redis', actor: '服务器 → Redis', chapter: '第三段：续期',
      body: '服务器制作新的 access_token，随机生成新的 refresh_token，再算出新 token_hash。新档案写进 Redis，两个 Set加入新 token_hash。因为仍属于同一条登录链，family_id 沿用原来的。',
      purpose: '让新 refresh_token 有自己的续期资格，并把这一轮新 access_token 和 refresh_token 关联到原来的登录组。',
      value: ['新 refresh_token / 新 token_hash', short(d.new.raw) + ' → ' + short(d.new.hash), '密码没有改变，所以 token_version 也不变。family_id 不变；token、token_hash、创建 / 到期时间变了。'],
      origin: '新 refresh_token 重新随机生成；新码用新 refresh_token 计算；token_version 根据当前账号资料计算；family_id 从旧档案沿用。',
      destination: '新主档案写 Redis；两个 Set 的成员现在可能同时有“旧 token_hash”和“新 token_hash”。旧主档案已不存在。',
      use: '新档案从现在重新计 30 天；两个名单键的 TTL 也重设为 30 天。新 access_token 从现在计自己的有效期。',
      raw: '新 refresh_token：' + d.new.raw + '\n新 token_hash：' + d.new.hash + '\n\nSET 新主档案：\n键：' + mainKey(d.new) + '\n值：\n' + d.new.recordJSON + '\nTTL = 30 天\n\nSADD ' + userKey + ' ' + d.new.hash + '\nSADD ' + familyKey + ' ' + d.new.hash + '\nEXPIRE 两个名单键 2592000\n\n两个名单成员可能为：\n' + d.old.hash + '\n' + d.new.hash, changed: ['redis','server']
    },
    {
      title: '浏览器覆盖保存新 token', actor: '服务器 → 浏览器', chapter: '第三段：续期',
      body: '服务器返回新 access_token、新 refresh_token 和新的有效秒数。浏览器覆盖原来的 access_token 和 refresh_token，并重算到期提醒。此后请求用新 access_token，下次续期用新 refresh_token。',
      purpose: '服务器虽然已经返回了新 access_token 和 refresh_token，浏览器也必须保存新 access_token 和 refresh_token，才能接着使用。',
      value: ['auth_token / token_expires_at / refresh_token', 'auth_token · token_expires_at · refresh_token', '不是把新 access_token 和 refresh_token 追加到一个数组，而是覆盖同名键的旧值。'],
      origin: '新的 token来自本次续期响应；到期提醒由前端按收到响应的时刻和 expires_in 计算。',
      destination: 'localStorage：先写新 auth_token 和 token_expires_at，最后写新 refresh_token；auth_user 仍用于页面资料。',
      use: '如果这次续期是接口 401 触发的，浏览器拿新 access_token 把原请求重试一次。',
      raw: 'localStorage.setItem("auth_token", 新 access_token)\nlocalStorage.setItem("token_expires_at", String(Date.now() + expires_in * 1000))\nlocalStorage.setItem("refresh_token", 新 refresh_token)\n\n本例假设在第二天 09:58 收到响应：\ntoken_expires_at = ' + d.new.browserExpiry + '\n\n同一页面的并发续期会共享正在执行的请求，支持 Web Locks 时还会协调同源页面；源码的后端轮换本身仍不是原子事务。', changed: ['browser']
    },
    {
      title: '退出：撤销 refresh_token，清理 localStorage', actor: '浏览器 → 服务器 → Redis', chapter: '第四段：退出',
      body: '浏览器把当前的新 refresh_token 发给退出接口。服务器算它的 token_hash、删除对应主档案；浏览器删除自己保存的四个登录键，并停止续期定时器。',
      purpose: '这个浏览器不再继续携带 access_token 访问，也不再用这个 refresh_token 续期。',
      value: ['退出后的存储结果', '浏览器四个键清空；当前主档案删除', '账号资料还在数据库；两个 Redis 名单仍可能留着旧、新 token_hash。'],
      origin: '要撤销的 refresh_token 原值从 localStorage.refresh_token 取出；服务器用它算出当前 token_hash。',
      destination: 'Redis 删除当前 refresh_token:token_hash；浏览器清掉 auth_token、refresh_token、auth_user、token_expires_at。',
      use: '正常删除后，再递交这张 refresh_token 就查不到档案。若有人另行保留了 access_token 副本，它仍可能在到期前通过检查；删除 refresh_token 记录不会改写 JWT。',
      raw: 'POST /api/v1/auth/logout\n请求体：{ "refresh_token": "' + d.new.raw + '" }\n\nRedis：DEL ' + mainKey(d.new) + '\n\n浏览器：removeItem("auth_token")\nremoveItem("refresh_token")\nremoveItem("auth_user")\nremoveItem("token_expires_at")\n停止续期定时器\n\n前端在退出请求失败时也会清本地；此时不能据此断言服务器已成功撤销。\n本步骤右侧展示服务器删除成功的路径。\n想理解改密为什么能使旧 JWT 失效，看下方“另一个结局”。', changed: ['browser','redis']
    }
  ];

  // 右侧“存储回执”与左侧使用同一个步骤状态，避免讲到新 access_token 和 refresh_token 却仍显示旧 token。
  function receipts(n) {
    const issued = n >= 7;
    const rotated = n >= 12;
    const deleted = n === 11 || n === 14;
    const pair = rotated ? d.new : d.old;
    const browserPair = n >= 13 ? d.new : d.old;
    const browserHasTickets = n >= 8 && n < 14;
    const userRow = `users 表，id = 42 这一行\nid: 42\nemail: ${d.email}\npassword_hash: ${d.passwordHash}\nrole: user\nstatus: active\n${n >= 8 ? 'last_login_at: 本次登录记录的时间\nlast_active_at: 最近活跃时间\n' : ''}\nsecurity_secrets 表，key = jwt_secret 这一行\nvalue: ${d.secret}\n\n这里没有 access_token、refresh_token 或 token_version 列。\n这把密钥是教学样本，不能拿它配置真实系统。`;
    let work = '系统签名密钥已从 PostgreSQL 加载到内存。';
    if (n === 1) work = '本次邮箱、输入密码和读出的用户资料，暂时在这里核对。';
    if (n >= 2 && n <= 8) work = '已经读到用户 42；' + (n >= 2 ? '算出 token_version；' : '') + (n >= 3 ? '已有 family_id；' : '') + (n >= 4 ? '已做 access_token；' : '') + (n >= 5 ? '已有 refresh_token；' : '') + (n >= 6 ? '已算 token_hash。' : '');
    if (n === 8 || n === 13) work = '响应已发出，请求的临时对象用完后释放；系统签名密钥继续留在运行配置中。';
    if (n === 9) work = '暂时解析 access_token、读取当前用户、重新计算 token_version 做比较。';
    if (n === 10 || n === 11) work = '已经读出旧档案里的用户编号、token_version、family_id 和期限，校验通过。';
    if (n === 12) work = '新 access_token、新 refresh_token、新 token_hash；沿用原 family_id，token_version 不变。';
    if (n === 14) work = '收到当前 refresh_token，重新算 token_hash，完成删除；请求临时材料用完即结束。';
    let redisText = '还没有本次登录的 refresh_token 记录。';
    let redisRaw = '本次登录相关的三个 key 都尚未写入。';
    if (issued) {
      redisText = deleted ? '主档案已删除。两个 Set还可能留有 token_hash；名单不能代替档案。' : `有${rotated ? '新' : '当前'}refresh_token 的主档案 + 两本查找名单。${rotated ? '旧主档案已删；名单可能留着旧码。' : ''}`;
      const members = rotated ? [d.old.hash, d.new.hash] : [d.old.hash];
      redisRaw = deleted ? `主档案：\n${mainKey(pair)}\n→ 已删除；GET 查不到\n` : `主档案（String；JSON 文字）：\n键：${mainKey(pair)}\n值：\n${pair.recordJSON}\n写入 TTL：30 天\n到期：${pair.refreshEnd}（UTC+8）\n`;
      redisRaw += `\nuser_refresh_tokens Set（Set）：\n键：${userKey}\n成员：\n${members.join('\n')}\n\ntoken_family Set（Set）：\n键：${familyKey}\n成员：\n${members.join('\n')}\n\n${rotated ? '新码加入时，两个名单键的 TTL 重设为 30 天。' : '名单写入时设 TTL 30 天；从那时开始倒计时。'}\n成员没有单独 TTL。token_hash 是键名和 Set 成员，不在 JSON 的字段中。`;
      if (rotated) redisRaw += `\n\n旧键 ${mainKey(d.old)} 已删除。`;
    }
    const liveMaterials = n === 8 || n === 13 ? '请求临时对象已用完。' : (n >= 2 && n < 14 ? 'token_version：' + d.version + '\n' : '') + (n >= 3 && n < 14 ? 'family_id：' + d.family + '\n' : '') + (n >= 6 && n !== 9 && n !== 8 && n !== 13 ? (rotated ? '新' : n >= 10 ? '旧' : '当前') + 'token_hash：' + pair.hash : '');
    const browserText = browserHasTickets ? `已保存${n >= 13 ? '新' : n >= 10 ? '旧' : '当前'}access_token、${n >= 13 ? '新' : n >= 10 ? '旧' : '当前'}refresh_token、用户资料、access_token 到期提醒。` : n === 14 ? '四个登录键已清空；定时器已停止。' : n === 1 ? '表单里有输入值；还没有收到 token。' : '本次登录的四个 localStorage 键还没保存。';
    const browserRaw = browserHasTickets ? `localStorage（值全是字符串）\n\nauth_token：\n${browserPair.access}\n\nrefresh_token：\n${browserPair.raw}\n\nauth_user：\n${userJSON}\n（只示意用于解释的资料字段，实际响应可能更多）\n\ntoken_expires_at：\n"${browserPair.browserExpiry}"\n前端预计到期：${browserPair.accessEnd}（UTC+8）\n\n没有独立保存 token_version、family_id 或 token_hash。\ntoken_version 和 family_id 已经装在 JWT 中。` : n === 14 ? '已 removeItem：\nauth_token\nrefresh_token\nauth_user\ntoken_expires_at\n\nlocalStorage 本身不会按期限自动删除 token。' : '还没有保存本次登录的 token。';
    return [
      { id:'pg', icon:'database', name:'PostgreSQL', text:'账号资料一直在这里。access_token 和 refresh_token 不写进 users 表。', raw:userRow },
      { id:'server', icon:'cpu', name:'后端内存', text:work, raw:`这一步临时读取 / 计算的材料，随请求使用。\n签名密钥由启动流程加载，留在运行配置中使用。\n\n${liveMaterials}\n\n内存工作对象不是 PostgreSQL 新加的一行；access_token 里的值也不会自动同步修改。` },
      { id:'redis', icon:'files', name:'Redis', text:redisText, raw:redisRaw },
      { id:'browser', icon:'monitor', name:'浏览器 · localStorage', text:browserText, raw:browserRaw }
    ];
  }

  // 先列清楚每个值。五项顺序固定，避免读者在故事、缩写和公式之间来回寻找。
  // 每个值的副本有自己的存放位置；“access_token 过期”不等于 localStorage 自动删掉字符串。
  const dictionary = [
    ['user_id / users.id', '用户编号',
      '注册账号时，由数据库分配。本例用户编号是 42。登录只是读取这个已有编号。',
      '没有 token 的过期时间，账号资料长期保存。',
      '原始编号在 PostgreSQL 的 users.id；登录后还复制到 JWT.user_id、Redis 档案的 user_id 和浏览器的用户资料中。',
      '准确说明“这是谁的账号”。',
      '服务器从 JWT 或 refresh_token 记录读出 user_id，再用它查回 users 表中的当前账号。'],
    ['email', '邮箱',
      '用户注册时填写，保存在账号资料里；本次登录时用户再次输入邮箱。',
      '没有 token 的过期时间；数据库中的邮箱在资料更新前一直保存。',
      'PostgreSQL users.email；签发时还复制进 JWT.email 和返回的用户资料。输入值也会暂时出现在登录请求中。',
      '找到要登录的账号；也是计算 token_version 的材料。',
      '登录时按输入邮箱查用户；后端用规范化邮箱与已存密码哈希一起计算 token_version。'],
    ['password', '本次输入的密码',
      '用户在登录框中输入。它不是从数据库里读出的明文密码。',
      '没有持久化 TTL；这次请求核对完就结束使用。',
      '本次表单和登录请求的临时内存中；不作为登录凭据写进 users、Redis 或 localStorage。',
      '证明输入密码的人是这个账号的主人。',
      '服务器用 bcrypt，把输入密码与 users.password_hash 比对；验证通过后再生成登录凭据。'],
    ['password_hash', '数据库保存的密码哈希',
      '注册或改密时，后端用 bcrypt 处理用户密码得到。数据库保存这个结果。',
      '没有 token 的过期时间；改密时替换成新哈希。',
      'PostgreSQL users.password_hash。登录时会读到后端内存；不交给浏览器。',
      '可以核对密码，同时不必保存明文密码。',
      '用途一：登录时用 bcrypt 核对输入密码。用途二：与邮箱一起计算 token_version；改密后哈希改变，token_version 也改变。'],
    ['role', '账号角色',
      '账号创建时使用默认角色（通常 user），之后可由账号管理修改。',
      '没有 token 的过期时间；账号角色更新时改变。',
      '当前值在 PostgreSQL users.role；签发时的角色副本在 JWT.role，返回的用户资料也可包含角色。',
      '说明这个账号能执行哪些业务操作。',
      '接口鉴权会查当前用户，业务授权使用数据库读取的当前角色；不能仅靠浏览器保存的角色决定权限。'],
    ['status', '账号状态',
      '账号创建和管理流程设置。正常可用状态是 active。',
      '没有 token 的过期时间；账号被停用等管理操作会改变它。',
      'PostgreSQL users.status。普通 JWT 载荷和 Redis refresh_token 记录不保存这一字段。',
      '说明这个账号现在是否允许使用。',
      '登录、访问接口和续期时检查当前状态。账号停用后，即使 access_token 还没到期，也会被拒绝。'],
    ['jwt_secret', '系统签名密钥',
      '系统启动时先读取数据库已有值；首次没有时保存配置值，或由后端安全随机生成后保存。',
      '没有 token 的 TTL；登录和续期不会自动生成一把新密钥。',
      'PostgreSQL security_secrets 表中 key = jwt_secret 那一行的 value；启动时还加载到后端内存。不会发给浏览器。',
      '让服务器能够检查 JWT 是否由系统签发、是否被改过。',
      '发 access_token 时用它签名；收到 access_token 时用它验签。数据库已有持久化值优先。'],
    ['token_version', '当前密码的标记',
      '后端读取数据库中的 email 和 password_hash，用这两项计算出一个数字。普通数据库加载路径中，它是这两项的指纹。',
      '没有独立的倒计时。密码哈希或邮箱变化会改变当前计算结果；已签发 token 里的旧值不会自动变化。',
      'JWT 的 token_version 字段；Redis refresh_token 记录 JSON 的 token_version 字段；计算时也在后端内存。PostgreSQL 没有独立的 token_version 列。',
      '识别“这个 token 是否对应当前账号的 token_version”。它不是续期次数。',
      '访问接口：比较 JWT 中的标记与根据最新账号资料算出的标记。续期：比较 Redis 档案中的标记。改密后不匹配，拒绝旧 token。'],
    ['family_id / sid', '本次登录的 family_id',
      '正式登录时，后端安全随机生成一个 32 位十六进制字符串。续期时读取旧档案，沿用原来的 family_id。',
      'family_id 本身没有独立 TTL。携带它的 JWT、refresh_token 记录各有期限；对应的 token_family Set key默认 30 天，每次加入新 token_hash 后重新计时。',
      'JWT 内叫 sid；Redis 档案内叫 family_id；Redis 的 token_family: 键名后面也拼这个 family_id。数据库 users 表不保存它。',
      '把同一次登录一路续期产生的凭据关联起来。',
      '续期时让新 access_token 和 refresh_token 继续属于这一组；需要撤销这条登录链时，用 family_id 找到对应 Set，再找到并删除该组的 refresh_token 记录。'],
    ['access_token / auth_token', '访问接口用的 JWT',
      '后端将用户编号、邮箱、角色、token_version、family_id 和时间写入 JWT，再用 jwt_secret 签名生成完整字符串。',
      '默认签发后 24 小时，由 JWT.exp 决定。改密或账号停用也会让它提前被拒绝。浏览器中的字符串不会因到期自动删除。',
      '响应字段名是 access_token；浏览器保存为 localStorage.auth_token。token_version 和 family_id 已经在这个 JWT 内部。PostgreSQL 和 Redis 不保存每个 JWT 原值。',
      '让后续接口请求证明用户身份。',
      '浏览器把它放在 Authorization: Bearer 后面；服务器验签、检查时间，再读当前用户检查状态和 token_version。'],
    ['refresh_token', '续期用的随机凭据',
      '后端安全随机生成 32 字节，转成 64 位十六进制文字，前面加 rt_。里面没有用户编号或 token_version。',
      '对应的 Redis 档案默认从生成时有效 30 天。正常轮换或退出删除档案后，refresh_token 原值即不能再续期；浏览器字符串没有自动删除 TTL。',
      '浏览器 localStorage.refresh_token 保存原值。续期或退出时发给服务器；Redis 不保存这个原值，而是保存其 token_hash 对应的档案。',
      'access_token 要过期时，可以换到新凭据，通常不必重新输入密码。',
      '续期时提交原值 → 后端重算 token_hash → 查 Redis 档案 → 核对账号和期限 → 删除旧档案、签发新 access_token 和 refresh_token。退出时也用它定位要删的档案。'],
    ['tokenHash / token_hash', 'refresh_token 的 token_hash',
      '后端对完整 refresh_token（包含 rt_）做 SHA-256，再转为 64 位十六进制文字。同一原值始终算出同一码。',
      '没有自己的独立期限。它所在的主档案键默认 30 天；两个 Set 键也有 TTL。删除主档案后，旧码仍可能留在 Set 中。',
      'Redis refresh_token: 键名的后半段；Redis user_refresh_tokens: 和 token_family: 两个 Set 的成员。不是 Redis JSON 的字段，不在浏览器单独保存。',
      '不用保存可直接使用的 refresh_token 原值，也能找到对应档案。',
      '续期和退出时，收到原值再算一次码，拼出 refresh_token:token_hash，对档案执行 GET 或 DEL。批量撤销时先从 Set 取码，再逐个定位主档案。'],
    ['expires_in', '服务端返回的有效秒数',
      '后端读取 access_token 有效期配置得到。默认 24 小时，即 86400 秒。',
      '这是时长，不是绝对到期时刻；它本身没有 TTL。',
      '登录 / 续期响应中的 expires_in 字段；浏览器读取后计算 token_expires_at，不把它当作独立的数据库记录保存。',
      '告诉前端这次新 access_token 可以使用多少秒。',
      '前端用“收到响应时的当前毫秒时间 + expires_in × 1000”，算到期提醒，并安排提前约 2 分钟续期。'],
    ['token_expires_at', '浏览器的到期提醒时间',
      '前端收到登录或续期响应后计算：Date.now() + expires_in × 1000。结果是毫秒时间戳。',
      '默认预计在收到响应后 24 小时到期。这个键不会自动消失；前端读取它安排提醒，退出等清理操作才会删除它。',
      '浏览器 localStorage.token_expires_at，保存为字符串。它不是 Redis TTL，也不是 PostgreSQL 字段。',
      '让前端知道什么时候该尝试续期。',
      '前端按此时间安排定时器或恢复登录状态。服务端最终是否接受 access_token，仍根据 JWT.exp 和当前账号判断。'],
    ['auth_user', '浏览器保存的用户资料',
      '登录后，服务器返回用户资料；前端把资料对象转成 JSON 字符串。',
      'localStorage 没有 TTL。退出或清理登录状态时删除；资料更新时可覆盖。',
      '浏览器 localStorage.auth_user。编号、邮箱等真实账号资料仍保存在 PostgreSQL。',
      '页面可以显示当前用户资料，并恢复前端状态。',
      '前端读取、解析 JSON 显示资料。服务器不把浏览器里这份资料当成访问授权依据，仍然检查真正的 JWT 和当前账号。']
  ];

  const tables = [
    ['access_token 内部：JWT 载荷中的每个字段', ['字段','来源 / 示例','目的'], [
      ['user_id','数据库 id：42','按编号查询当前用户。'],['email','数据库 email：' + d.email,'签发时的邮箱资料；当前身份仍以服务器读取的账号为准。'],['role','数据库 role：user','签发时的角色；业务授权使用读取的当前角色。'],['token_version','从 email + password_hash 算出的 token_version','与当前 token_version 比较，发现改密。'],['sid','本次登录的 family_id','把 access_token 关联到同一条登录链。'],['bnd（可选）','请求 IP + User-Agent 的绑定指纹','校验使用环境；无绑定材料时可省略，默认关闭校验。'],['iat','后端签发时的 Unix 秒时间','记录何时签发。'],['nbf','本次签发时的 Unix 秒时间','在此时间之前不能使用。'],['exp','后端当前时间 + 访问有效期，Unix 秒','服务器判断是否过期。']]],
    ['Redis 主档案：String 里的 JSON 每个字段', ['字段','从哪里来','做什么'], [
      ['user_id','数据库 id','定位用户资料。'],['token_version','从邮箱与密码哈希算出的标记','续期时与当前标记比较。'],['family_id','登录随机生成，续期时沿用','找到这一组的名单；新 access_token 和 refresh_token 继续归入这一组。'],['binding_hash（可选）','请求 IP + User-Agent 的指纹','可选环境绑定校验；为空可省略。'],['created_at','服务器生成 refresh_token 时的时间','记录该档案创建时间。'],['expires_at','created_at + 刷新有效天数','程序判断是否过期；JSON 使用时间文本，不是 Unix 毫秒。']]],
    ['PostgreSQL：登录主线存了哪些列？', ['表.列 / 类型','来源','目的'], [
      ['users.id / BIGINT','数据库分配','标识账号；JWT 和 Redis 的 user_id 指向它。'],['users.email / VARCHAR(255)','注册或账号资料更新','按邮箱登录；也是 token_version 的材料。'],['users.password_hash / VARCHAR(255)','后端 bcrypt 处理注册 / 新密码','核对密码；也是 token_version 的材料。'],['users.role / VARCHAR(20)','用户角色配置，通常 user','决定当前业务权限。'],['users.status / VARCHAR(20)','账号管理，正常是 active','判断账号当前能否使用。'],['users.last_login_at / TIMESTAMPTZ，可空','登录流程尝试写入的时间','记录最近成功登录。'],['users.last_active_at / TIMESTAMPTZ，可空','登录记录 / 鉴权后的活跃更新','记录最近活跃。'],['security_secrets.id / BIGSERIAL','数据库分配','标识这一行密钥记录。'],['security_secrets.key / VARCHAR(100)，唯一','系统命名：jwt_secret','定位是哪一种系统密钥。'],['security_secrets.value / TEXT','首次配置或安全随机生成，之后使用已存值','保存系统签名密钥。'],['security_secrets.created_at、updated_at / TIMESTAMPTZ','记录创建 / 更新的时间','维护密钥记录，不是登录 token 的期限。'],['settings.key / VARCHAR(100)，唯一','设置名，如 session_binding_enabled','标识功能开关。'],['settings.value / TEXT','设置值，如 "false"','控制可选绑定校验。'],['settings.updated_at / TIMESTAMPTZ','设置更新时的时间','维护设置记录。']]],
    ['浏览器：localStorage 四个键', ['键','值的来源','目的'], [
      ['auth_token','服务端响应中的 access_token 完整原值','接口请求的 access_token。'],['refresh_token','服务端响应中的 refresh_token 完整原值','续期和退出。'],['auth_user','服务端返回的用户资料，JSON.stringify 后保存','显示用户资料、恢复页面状态；不能据此代替服务器授权。'],['token_expires_at','前端当前毫秒时间 + expires_in × 1000，再转字符串','安排续期提醒；没有自动删除 TTL。']]]
  ];

  const actualName = field => field.startsWith('tokenHash') ? 'token_hash' : field.split(' / ')[0];
  const nameNote = field => field === 'access_token / auth_token' ? '响应字段：access_token；浏览器保存键：auth_token。' : field === 'family_id / sid' ? 'Redis 字段：family_id；JWT 中相同的值放在 sid 字段。' : field === 'user_id / users.id' ? '来自数据库 users.id；JWT 和 Redis 记录中字段名为 user_id。' : field.startsWith('tokenHash') ? '源码中的局部变量叫 tokenHash；它不是 Redis JSON 的字段。' : '';
  $('value-index').innerHTML = dictionary.map(([field], i) => `<a class="btn" data-variant="outline" href="#value-${i}"><code>${escape(actualName(field))}</code></a>`).join('');
  $('value-dictionary').innerHTML = dictionary.map(([field,name,origin,expiry,place,purpose,later], i) => `<article id="value-${i}" class="card gap-0 min-w-0 scroll-mt-5 p-5 sm:p-6"><div class="mb-5"><h3 class="text-xl font-semibold"><code>${escape(actualName(field))}</code></h3>${nameNote(field) ? `<p class="mt-2 text-sm leading-7 text-subtle">${escape(nameNote(field))}</p>` : ''}</div><dl class="space-y-4">${[['来源',origin],['过期时间',expiry],['存在哪里',place],['目的',purpose],['后续怎么用',later]].map(([label,text])=>`<div class="flex items-start gap-4"><dt class="w-20 shrink-0 text-sm font-semibold leading-8 text-subtle">${label}</dt><dd class="min-w-0 flex-1 text-base leading-8">${escape(text)}</dd></div>`).join('')}</dl></article>`).join('');
  // 字段对照也保持五项完整：不是只给出字段名字，让读者自己猜存储期限。
  const fullTables = tables.map(([title,cols,rows], index) => {
    const enriched = rows.map(([field,origin,purpose]) => {
      let expiry,place,later;
      if (index === 0) {
        expiry = '字段没有单独 TTL。JWT 默认有效 24 小时；浏览器里的 JWT 字符串不自动删除。';
        place = 'JWT 载荷内部，整个 JWT 保存在浏览器 localStorage.auth_token。';
        later = ({user_id:'按编号重新查 PostgreSQL 用户。', email:'取得签发时邮箱资料，账号身份以当前数据库资料为准。', role:'业务权限使用重新查询的当前角色。', token_version:'与当前账号计算出的 token_version 比较。', sid:'关联这一登录组。', 'bnd（可选）':'开启绑定校验时与当前请求指纹比较。', iat:'读取签发时间；它不负责 Redis 倒计时。', nbf:'校验 access_token 时检查当前时间是否已经达到它。', exp:'校验 access_token 时检查当前时间是否已经到期。'})[field];
      } else if (index === 1) {
        expiry = '跟随该主档案保存：默认 30 天；轮换、退出或撤销也可能提前删除。';
        place = 'Redis refresh_token:token_hash 对应的 String 中，作为 JSON 的一个字段。';
        later = ({user_id:'据此查询当前账号。',token_version:'据此与当前 token_version 比较。',family_id:'生成新凭据时沿用；撤销此登录组时找对应 Set。','binding_hash（可选）':'开启绑定时比较当前请求指纹。',created_at:'读出这个 refresh_token 的创建时间；续期的新档案会写新时间。',expires_at:'续期时与服务器当前时间比较，过期就拒绝。'})[field];
      } else if (index === 2) {
        expiry = '没有登录 token 的 TTL；记录会长期保存，更新或删除由账号 / 系统管理流程决定。';
        place = 'PostgreSQL，左栏表名中的对应列。';
        later = purpose;
      } else {
        place = '浏览器 localStorage，键名见左栏，值都是字符串。';
        expiry = field === 'auth_token' ? 'JWT 默认有效 24 小时；此浏览器键没有自动删除 TTL。' : field === 'refresh_token' ? '资格由 Redis 主档案决定，默认 30 天；此浏览器键没有自动删除 TTL。' : '没有自动删除 TTL；退出或清理登录状态时删除。';
        later = ({auth_token:'取出 JWT，放到请求头 Authorization: Bearer 后面。',refresh_token:'取出原值，发给续期或退出接口。',auth_user:'解析 JSON，显示资料、恢复页面状态。',token_expires_at:'读取毫秒时间，安排或恢复续期定时器。'})[field];
      }
      return [field,origin,expiry,place,purpose,later];
    });
    return [title,enriched];
  });
  fullTables.push(['Redis 的三个键：是谁创建，里面存什么，什么时候删？', [
    ['refresh_token:token_hash','后端先对 refresh_token 原值算 token_hash，再在前面加 refresh_token:。','写入时设 TTL，默认 30 天；轮换 / 退出 / 撤销可能提前 DEL。JSON.expires_at 还供程序检查。','Redis String。键名包含 token_hash；value 是用户编号、token_version、family_id、创建 / 到期时间组成的 JSON。','保存这一个 refresh_token 的使用资格。','续期时 GET 检查资格；轮换或退出时 DEL。主记录有效才可能通过续期，Set 成员不能代替它。'],
    ['user_refresh_tokens:用户编号','后端在 user_refresh_tokens: 后拼数据库用户编号；例如 user_refresh_tokens:42。','默认整个 Set 30 天，每次加入新 token_hash 时重设 TTL。单个成员没有 TTL，旧成员可能残留。','Redis Set。每个成员是一个 refresh_token 的 token_hash，包含这个用户的不同登录组。','能找到同一个用户的所有 refresh_token 记录。','批量撤销时 SMEMBERS 取出码，拼主记录键名并删除，再删除用户 Set；家族 Set 可能仍留下。'],
    ['token_family:family_id','后端在 token_family: 后拼本次随机生成的 family_id；续期沿用同一键。','默认整个 Set 30 天，每次加入新 token_hash 时重设 TTL。单个成员没有 TTL，旧成员可能残留。','Redis Set。每个成员是这个登录组沿途发出的 refresh_token token_hash。','能找到这一条登录链的 refresh_token 记录。','撤销此组时 SMEMBERS 取码，删除对应主记录，再删除家族 Set；用户 Set 的旧成员可能仍留下。']
  ]]);
  const fieldHeaders = ['值 / 字段','来源','过期时间','存在哪里','目的','后续怎么用'];
  $('field-tables').innerHTML = fullTables.map(([title,rows]) => `<details class="card p-5"><summary>${escape(title)}</summary><p class="mb-3 mt-2 text-sm text-subtle">窄屏可左右滑动表格。所有字段都按同样的五项解释。</p><div class="table-scroll" tabindex="0" role="region" aria-label="${escape(title)}"><table><thead><tr>${fieldHeaders.map(c=>`<th scope="col">${escape(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((cell,i)=>`<td>${i===0 ? '<code>' + escape(cell) + '</code>' : escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`).join('');
  const sourceRoot = 'https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/';
  // 期限章节直接附固定版本的出处。命令是等价说明，不在浏览器执行 Redis 写入。
  const sourceLink = (path,label) => `<a class="source-link" href="${sourceRoot + path}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`;
  const redisKeys = [
    ['refresh_token:{token_hash}', [
      ['数据结构','String。value 是整段 JSON 文字；不是 Redis Hash。'],
      ['key 的来源','后端对 refresh_token 原值做 SHA-256，得到 token_hash，再拼上 refresh_token:。大括号表示需要替换的位置，不是实际 key 的字符。'],
      ['value 的内容','user_id、token_version、family_id、created_at、expires_at；有绑定材料时还可含 binding_hash。refresh_token 原值不存进去，token_hash 在 key 中。'],
      ['TTL','默认 2592000 秒（30 天）。传入的 ttl 来自 jwt.refresh_token_expire_days × 24 小时。'],
      ['怎么设置','StoreRefreshToken 使用 rdb.Set(ctx, key, val, ttl)，写入 String 时一起设置 key 的 TTL。JSON.expires_at 另用 now.Add(ttl) 算出。'],
      ['后续怎么用','续期 GET 读取并解析 JSON；核对通过后 DEL 旧 key，再为新 refresh_token 创建一个新 key。退出、撤销也可能提前 DEL。GET 不会续上 TTL。'],
      ['谁处理过期','Redis 使到期 key 不再可读，并清理数据；续期程序还会检查 JSON.expires_at。']
    ], 'SET refresh_token:{token_hash} "序列化后的 JSON" EX 2592000\nGET refresh_token:{token_hash}\nTTL refresh_token:{token_hash}', 'backend/internal/repository/refresh_token_cache.go#L43-L66'],
    ['user_refresh_tokens:{user_id}', [
      ['数据结构','Set：不重复的 token_hash 集合。不是 JSON，不保存用户对象。'],
      ['key 的来源','user_id 来自 PostgreSQL users.id。本例 key = user_refresh_tokens:42。'],
      ['value 的内容','这个用户生成过的 refresh_token 的 token_hash。可以包含手机、电脑等不同登录的 token_hash，也可能保留已失效的旧成员。'],
      ['TTL','默认整个 key 2592000 秒（30 天）；每个成员没有单独 TTL。'],
      ['怎么设置','AddToUserTokenSet 在 pipeline 中执行 SADD，然后执行 EXPIRE key ttl。每次生成新 refresh_token 都执行，所以整个 Set 从最近这次写入重新计时。SADD 本身不设置或延长 TTL。'],
      ['后续怎么用','撤销用户的 refresh_token 时，SMEMBERS 取所有 token_hash，再拼出各个 refresh_token: key 并 DEL，最后删用户 Set。'],
      ['谁处理过期','Redis 让整个 Set key 到期。某个 String 被删除或先到期，不会自动从这个 Set 移除对应成员。']
    ], 'SADD user_refresh_tokens:42 {token_hash}\nEXPIRE user_refresh_tokens:42 2592000\nSMEMBERS user_refresh_tokens:42\nTTL user_refresh_tokens:42', 'backend/internal/repository/refresh_token_cache.go#L127-L133'],
    ['token_family:{family_id}', [
      ['数据结构','Set：不重复的 token_hash 集合。'],
      ['key 的来源','family_id 在正式登录时随机生成；同一条登录链续期时沿用，拼在 token_family: 后。'],
      ['value 的内容','这一次登录以及后续轮换产生的 refresh_token 的 token_hash；可能还留着旧成员。'],
      ['TTL','默认整个 key 2592000 秒（30 天）；不是给 family_id 单独设置 TTL。成员没有单独 TTL。'],
      ['怎么设置','AddToFamilyTokenSet 执行 SADD，再执行 EXPIRE key ttl。续期写入新 token_hash 后，整个 Set 的 TTL 重新变成 30 天。'],
      ['后续怎么用','撤销这一条登录链时，SMEMBERS 读取 token_hash，DEL 对应 String，再 DEL 此 Set。它不代表某个 access_token 一定仍有效。'],
      ['谁处理过期','Redis 让整个 key 到期。读取成员不会延长 TTL。只有代码再次 EXPIRE 才重设期限。']
    ], 'SADD token_family:{family_id} {token_hash}\nEXPIRE token_family:{family_id} 2592000\nSMEMBERS token_family:{family_id}\nTTL token_family:{family_id}', 'backend/internal/repository/refresh_token_cache.go#L136-L142']
  ];
  const factRows = facts => `<dl class="mt-4 space-y-4">${facts.map(([label,text]) => `<div><dt class="text-sm font-semibold text-subtle">${escape(label)}</dt><dd class="mt-1 leading-8">${escape(text)}</dd></div>`).join('')}</dl>`;
  $('redis-key-cards').innerHTML = redisKeys.map(([key,facts,commands,path]) => `<article class="card gap-0 min-w-0 p-5 sm:p-6"><h3 class="text-xl font-semibold"><code>${escape(key)}</code></h3>${factRows(facts)}<p class="mb-2 mt-5 text-sm font-semibold">等价 Redis 命令（默认配置的说明，未执行）</p>${code(commands)}<details class="mt-3"><summary class="text-sm">查看本页示例中实际保存的 value</summary>${code(key.startsWith('refresh_token:') ? d.old.recordJSON : 'Set 的一个成员（完整 token_hash）：\n' + d.old.hash + '\n\n这不是 JSON 对象，也没有每个成员的 expires_at。')}</details><p class="mt-3 text-sm leading-7">依据：${sourceLink(path,'对应存储代码')}；${sourceLink('backend/internal/service/auth_service.go#L1745-L1773','ttl 的计算与传递')}；${sourceLink('backend/internal/config/config.go#L2319-L2321','30 天默认配置')}。</p></article>`).join('');
  const expirationFacts = [
    ['access_token → JWT.exp', [
      ['设置依据','jwt.access_token_expire_minutes 大于 0 时优先用分钟；否则用 jwt.expire_hour，默认 24 小时。'],
      ['怎么存和设置','后端计算 expiresAt = now + 配置时长，用 jwt.NewNumericDate(expiresAt) 写入 JWT.exp。exp 是 Unix 秒时间戳。JWT 签名后整体交给浏览器，前端用 localStorage.setItem("auth_token", access_token) 保存。'],
      ['到期后的处理','服务器验 JWT 时按 exp 拒绝过期 access_token；没有为 JWT 设置 Redis TTL。localStorage 里的字符串不会自动删除，登录/续期覆盖、退出清理。iat 是签发时刻，nbf 是开始可用时刻，都不是另一份 TTL。']
    ], 'backend/internal/service/auth_service.go#L1420-L1459'],
    ['refresh_token → Redis JSON.expires_at + key TTL', [
      ['设置依据','jwt.refresh_token_expire_days，默认 30 天。ttl = 配置天数 × 24 小时。'],
      ['怎么存和设置','now 是后端当前时间；created_at = now，expires_at = now.Add(ttl)。Go 的 time.Time 序列化成 RFC3339 时间文字（可带小数秒和时区），放在 String 的 JSON 里。同时 rdb.Set(..., ttl) 把相同时长交给 Redis，设整个 key 的倒计时。'],
      ['到期后的处理','JSON.expires_at 是程序要比较的截止时刻；key TTL 是 Redis 执行的存活时长。只把 expires_at 写进 JSON 不会让 Redis 自动删除，必须同时设置 key TTL。refresh_token 原值没有内嵌 exp，浏览器也未给它设置 TTL。']
    ], 'backend/internal/service/auth_service.go#L1745-L1808'],
    ['user_refresh_tokens / token_family → key TTL', [
      ['设置依据','生成 refresh_token 时使用的同一个 ttl，默认 30 天。'],
      ['怎么存和设置','两个 Set 不保存 expires_at 字段。期限通过 EXPIRE 设在 Redis key 的过期元数据中，不是一个 Set 成员。可以用 TTL key 查看剩余秒数；TTL 返回 -1 表示 key 没设置期限，-2 表示 key 不存在。'],
      ['到期后的处理','整个 Set key 失效；每次新生成 refresh_token，都重新 EXPIRE 两个 Set。已有成员跟着整个 Set 保留，不能依据成员存在判断 refresh_token 有效。']
    ], 'backend/internal/repository/refresh_token_cache.go#L127-L152'],
    ['expires_in → 响应中的秒数', [
      ['设置依据','由 access_token 的同一有效期配置换算秒数：分钟 × 60，或小时 × 3600，默认 86400。'],
      ['怎么存和设置','后端放在登录/续期响应的 expires_in 中。它只是数字时长，自己没有到期机制；前端读它计算 token_expires_at。'],
      ['到期后的处理','不会对 expires_in 执行 EXPIRE，也不作为 PostgreSQL 持久化列。新响应会给新的有效秒数。']
    ], 'backend/internal/service/auth_service.go#L1453-L1459'],
    ['token_expires_at → localStorage 的毫秒字符串', [
      ['设置依据','前端收到响应时的 Date.now() + expires_in × 1000。默认约为收到响应后 24 小时。'],
      ['怎么存和设置','前端计算 expiresAtMs，并执行 localStorage.setItem("token_expires_at", String(expiresAtMs))。只保存一个时间数字的字符串，没有设置浏览器自动删除期限。'],
      ['到期后的处理','前端读取此值，通常安排提前 2 分钟尝试续期；它是前端定时依据，不是服务器认可的 JWT.exp。刷新成功重新计算、覆盖；退出清理。浏览器时钟和响应延迟可能让它与 exp 略有差异，服务端以 JWT.exp 为准。']
    ], 'frontend/src/stores/auth.ts#L170-L205'],
    ['token_version / token_hash / family_id 以及其他字段', [
      ['设置依据','这些值本身不单独调用 EXPIRE。user_id、email、role、status、password_hash、jwt_secret 也没有登录 token 的独立倒计时。'],
      ['怎么存和设置','在 JWT 内的 user_id、email、role、token_version、sid、可选 bnd 跟随整个 access_token 的 exp；在 Redis JSON 内的 user_id、token_version、family_id、可选 binding_hash、created_at、expires_at 跟随整个 String key 的 TTL。token_hash 在 key 和 Set 成员中，跟随所在 key。'],
      ['到期后的处理','副本不会互相自动同步。token_version 会因当前邮箱/密码哈希改变而重新算出不同结果；family_id 沿用至该登录链后续续期；token_hash 根据对应 refresh_token 确定。没有“token_version 单独 30 天后消失”之类的设置。']
    ], 'backend/internal/service/refresh_token_cache.go#L14-L21'],
    ['PostgreSQL 资料 / localStorage.auth_user / 后端内存', [
      ['设置依据','这些位置没有 Redis 式登录 TTL。数据库的 created_at、updated_at、last_login_at、last_active_at 是事件时间，不是自动删除期限。'],
      ['怎么存和设置','PostgreSQL 保存账号、密码哈希、系统密钥和设置行，按业务更新。auth_user 用 JSON.stringify 后 setItem 到浏览器。请求中的 password、计算材料暂时在内存；jwt_secret 启动后加载进运行配置，供后端持续签名验签。'],
      ['到期后的处理','数据库记录长期保存，由业务管理更新/删除；浏览器四个 key 在退出或清理登录状态时 removeItem，不会自动按时间清理。请求临时材料结束使用后由运行时管理，不用 Redis EXPIRE。']
    ], 'frontend/src/stores/auth.ts#L295-L329']
  ];
  $('expiration-cards').innerHTML = expirationFacts.map(([title,facts,path],index) => `<article class="card gap-0 min-w-0 p-5 sm:p-6"><h3 class="text-lg font-semibold">${escape(title)}</h3>${factRows(facts)}<p class="mt-4 text-sm">依据：${sourceLink(path,'查看对应源码')}${index===2 ? '；<a class="source-link" href="https://redis.io/docs/latest/commands/ttl/" target="_blank" rel="noopener noreferrer">Redis TTL 命令说明</a>' : ''}。</p></article>`).join('');
  const sources = [
    ['backend/internal/service/auth_service.go#L1689-L1931','正式凭据对、随机值、轮换与 token_version'],
    ['backend/internal/service/auth_service.go#L1420-L1459','JWT 载荷、签名与访问期限'],
    ['backend/internal/service/refresh_token_cache.go#L14-L21','Redis JSON 字段'],
    ['backend/internal/repository/refresh_token_cache.go#L13-L156','Redis 键、String、Set、TTL 与删除'],
    ['backend/internal/repository/security_secret_bootstrap.go#L21-L128','系统签名密钥的持久化和加载'],
    ['backend/ent/schema/user.go#L39-L116','用户行涉及的字段'],
    ['backend/internal/server/middleware/jwt_auth.go#L38-L115','普通接口鉴权：重新读取当前账号'],
    ['backend/internal/service/session_binding.go#L25-L36','可选绑定指纹'],
    ['frontend/src/stores/auth.ts#L105-L329','浏览器保存登录状态与安排定时续期'],
    ['frontend/src/api/tokenRefresh.ts#L50-L229','续期时覆盖 token 的顺序与协调']
  ];
  $('source-links').innerHTML = sources.map(([path,label]) => `<li><a class="source-link" href="${sourceRoot + path}" target="_blank" rel="noopener noreferrer">${escape(label)}</a></li>`).join('');
  $('step-select').innerHTML = steps.map((s,i)=>`<option value="${i}">${i+1}. ${escape(s.title)}</option>`).join('');

  let entrance;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function render(animate = false) {
    const n = state.step;
    const s = steps[n];
    $('step-count').textContent = `第 ${n+1} 步 / 共 ${steps.length} 步`;
    $('chapter-label').textContent = s.chapter;
    $('actor').textContent = s.actor;
    $('lesson-title').textContent = s.title;
    $('lesson-body').textContent = s.body;
    $('lesson-purpose').textContent = s.purpose;
    $('value-card').innerHTML = `<div class="value-paper"><p class="text-sm font-semibold">本步的值：${escape(s.value[0])}</p><code class="value-example">${escape(s.value[1])}</code><p class="mt-2 text-sm leading-7 text-subtle">${escape(s.value[2])}</p></div>`;
    $('lesson-facts').innerHTML = [['从哪里来',s.origin],['现在 / 最后放在哪里',s.destination],['之后拿它做什么',s.use]].map(([label,value])=>`<p class="text-base leading-8"><span class="fact-label">${label}</span>${escape(value)}</p>`).join('');
    $('lesson-code').innerHTML = code(s.raw);
    // 原生 details 负责展开；只在切换步骤时关闭上一页的命令，不制造第二个组件控制器。
    $('step-code').open = false;
    const open = new Set([...$('storage-board').querySelectorAll('details[open]')].map(el=>el.dataset.id));
    $('storage-board').innerHTML = receipts(n).map(r => `<section class="receipt${s.changed.includes(r.id) ? ' changed' : ''}" data-place="${r.id}"><div class="receipt-heading"><i data-lucide="${r.icon}" aria-hidden="true"></i><h4>${r.name}</h4>${s.changed.includes(r.id) ? '<span class="receipt-badge">本步涉及</span>' : ''}</div><p class="receipt-text">${escape(r.text)}</p><details data-id="${r.id}"${open.has(r.id) ? ' open' : ''}><summary>展开本步的实际内容</summary>${code(r.raw)}</details></section>`).join('');
    $('step-select').value = String(n);
    $('prev').disabled = n === 0;
    $('next-label').textContent = n === steps.length - 1 ? '从头再看' : '下一步';
    $('next-hint').textContent = n === steps.length - 1 ? '故事结束。下面还能查看“改密”和“多设备”的结局。' : '接下来：' + steps[n+1].title;
    $('step-announcement').textContent = `第 ${n+1} 步：${s.title}`;
    window.lucide.createIcons();
    // 淡入只用于提示“内容已经换成下一步”。停止旧动画，避免连续点击状态竞争。
    if (entrance) entrance.stop();
    $('lesson').style.opacity = '1';
    if (animate && !reducedMotion.matches && window.Motion) {
      entrance = window.Motion.animate($('lesson'), { opacity: [0.75, 1] }, { duration: 0.16 });
    }
  }
  function go(n) { state.step = n; render(true); $('story').scrollIntoView({ block: 'start', behavior: 'instant' }); }
  $('prev').addEventListener('click', () => go(Math.max(0,state.step-1)));
  $('next').addEventListener('click', () => go(state.step === steps.length-1 ? 0 : state.step+1));
  $('step-select').addEventListener('change', event => go(Number(event.target.value)));
  reducedMotion.addEventListener('change', () => { if (entrance) entrance.stop(); $('lesson').style.opacity='1'; });
  render();
})();
