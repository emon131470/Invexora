/* =====================================================
   INVEXORA (DEMO / SIMULATION) - app.js

   TWO MODES (automatic):
   1) LOCAL MODE  - works right away, no setup. Data is saved
                    in this browser only. The email code is
                    shown on screen (no email is sent).
   2) SUPABASE MODE - real backend. Paste your Supabase URL and
                    anon key below and it switches on by itself.
   ===================================================== */

(function () {

    "use strict";

    var root = window;

    /* ---------- SETTINGS ---------- */

    // Leave these two as they are to use LOCAL MODE.
    // Paste your real values (Supabase > Project Settings > API) for SUPABASE MODE.
    var SUPABASE_URL      = "https://qfrjxdrfuddvqbowgzfy.supabase.co";
    var SUPABASE_ANON_KEY = "sb_publishable_dN--YH5u1dHimzmJld2vww_wndNdluw";

    // LOCAL MODE only: these emails become admin when they register.
    // (The very first account that registers is always admin.)
    var LOCAL_ADMIN_EMAILS = [];

    var CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    var RESEND_SECONDS = 30;
    var CODE_LENGTH    = 6;

    var useSupabase = /^https?:\/\//.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 40;
    var needLogin   = document.body.classList.contains("dashboard-page");


    /* ---------- small helpers ---------- */

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                                         .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function lower(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

    function maskEmail(e) {
        var p = String(e || "").split("@");
        return p.length === 2 ? p[0].slice(0, 2) + "***@" + p[1] : (e || "");
    }

    function friendly(err) {

        var m = (err && err.message) || "Something went wrong. Please try again.";

        if (/signups? not allowed|user not found|not found/i.test(m)) return "No account found with this email. Please register first.";
        if (/rate limit|security purposes|too many|only request this after/i.test(m)) return "Too many requests. Please wait a minute and try again.";
        if (/expired|invalid/i.test(m)) return "That code is wrong or has expired.";
        if (/failed to fetch|network/i.test(m)) return "Network problem. Check your internet connection.";

        return m;
    }

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error("Could not load the Supabase library.")); };
            document.head.appendChild(s);
        });
    }


    /* =====================================================
       LOCAL BACKEND  (a small fake Supabase that runs in the
       browser, so the whole site works without any setup)
       ===================================================== */

    /* LOCAL_BACKEND_START */
    function createLocalClient(opts) {

        opts = opts || {};

        var DB_KEY      = "INVEXORA_local_db";
        var SESSION_KEY = "INVEXORA_local_session";
        var ADMINS      = (opts.adminEmails || []).map(lower);
        var otps        = {};

        function pad(n) { return (n < 10 ? "0" : "") + n; }
        function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
        function today() { return opts.today ? opts.today() : ymd(new Date()); }
        function dayNum(s) { var p = s.split("-"); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); }
        function addDays(s, n) {
            var d = new Date((dayNum(s) + n) * 86400000);
            return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
        }
        function round2(n) { return Math.round(n * 100) / 100; }
        function nowIso() { return new Date().toISOString(); }
        function uid() {
            return (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
                : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        }
        function sum(list, f) { return list.reduce(function (s, x) { return s + Number(f(x) || 0); }, 0); }
        function copy(x) { return JSON.parse(JSON.stringify(x)); }

        function seed() {
            return {
                authUsers: [], profiles: [],
                plans: [
                    { id: "starter", name: "Starter", min_amount: 10,  max_amount: 50,   duration_days: 50,  daily_rate: 1.0, referral_rate: 5,  featured: false, active: true, sort_order: 1 },
                    { id: "silver",  name: "Silver",  min_amount: 50,  max_amount: 100,  duration_days: 90,  daily_rate: 1.2, referral_rate: 6,  featured: false, active: true, sort_order: 2 },
                    { id: "gold",    name: "Gold",    min_amount: 100, max_amount: 500,  duration_days: 120, daily_rate: 1.5, referral_rate: 8,  featured: true,  active: true, sort_order: 3 },
                    { id: "diamond", name: "Diamond", min_amount: 500, max_amount: 1000, duration_days: 180, daily_rate: 2.0, referral_rate: 10, featured: false, active: true, sort_order: 4 }
                ],
                settings: { id: 1, min_withdraw: 5, return_principal: true },
                deposits: [], investments: [], profit_logs: [], referral_earnings: [], withdrawals: [],
                seq: 0
            };
        }

        function load() {
            try {
                var d = JSON.parse(localStorage.getItem(DB_KEY));
                if (d && d.plans && d.profiles) return d;
            } catch (e) {}
            return seed();
        }

        function save(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

        function me(db) {
            var id = localStorage.getItem(SESSION_KEY);
            if (!id) return null;
            for (var i = 0; i < db.profiles.length; i++) if (db.profiles[i].id === id) return db.profiles[i];
            return null;
        }

        function isAdmin(db) { var m = me(db); return !!(m && m.role === "admin"); }

        function genCode(db) {
            var c;
            do {
                c = "IP" + Math.random().toString(16).slice(2, 8).toUpperCase();
            } while (db.profiles.some(function (p) { return p.referral_code === c; }));
            return c;
        }

        function sessionOf(p) {
            return { user: { id: p.id, email: p.email }, access_token: "local" };
        }


        /* ----- the same business rules as the SQL file ----- */

        function balanceOf(db, userId) {
            var profit   = sum(db.profit_logs.filter(function (l) { return l.user_id === userId; }), function (l) { return l.amount; });
            var referral = sum(db.referral_earnings.filter(function (r) { return r.referrer_id === userId; }), function (r) { return r.amount; });
            var back     = db.settings.return_principal
                ? sum(db.investments.filter(function (i) { return i.user_id === userId && i.status === "completed"; }), function (i) { return i.amount; }) : 0;
            var used     = sum(db.withdrawals.filter(function (w) { return w.user_id === userId && (w.status === "pending" || w.status === "approved"); }), function (w) { return w.amount; });
            return round2(profit + referral + back - used);
        }

        function accrue(db, userId) {

            var t = today(), added = 0;

            db.investments.forEach(function (inv) {

                if (inv.status !== "running") return;
                if (userId && inv.user_id !== userId) return;

                var passed = dayNum(t) - dayNum(inv.start_date);
                var maxday = Math.min(inv.duration_days, passed);

                for (var d = 1; d <= maxday; d++) {
                    var exists = db.profit_logs.some(function (l) { return l.investment_id === inv.id && l.day_number === d; });
                    if (!exists) {
                        db.profit_logs.push({
                            id: ++db.seq, investment_id: inv.id, user_id: inv.user_id,
                            day_number: d, profit_date: addDays(inv.start_date, d),
                            amount: round2(inv.amount * inv.daily_rate / 100)
                        });
                        added++;
                    }
                }

                if (passed >= inv.duration_days) inv.status = "completed";
            });

            return added;
        }

        function needLoginRow(db) {
            var m = me(db);
            if (!m) throw new Error("Please login first");
            return m;
        }

        function needAdmin(db) {
            if (!isAdmin(db)) throw new Error("Admins only");
        }

        var rpcs = {

            referral_code_exists: function (db, a) {
                var c = String(a.p_code || "").trim().toUpperCase();
                return !!c && db.profiles.some(function (p) { return p.referral_code === c; });
            },

            accrue_my_profits: function (db) {
                var m = needLoginRow(db);
                return accrue(db, m.id);
            },

            my_summary: function (db) {
                var m = needLoginRow(db);
                return {
                    available:    balanceOf(db, m.id),
                    profit:       round2(sum(db.profit_logs.filter(function (l) { return l.user_id === m.id; }), function (l) { return l.amount; })),
                    referral:     round2(sum(db.referral_earnings.filter(function (r) { return r.referrer_id === m.id; }), function (r) { return r.amount; })),
                    active:       round2(sum(db.investments.filter(function (i) { return i.user_id === m.id && i.status === "running"; }), function (i) { return i.amount; })),
                    used:         round2(sum(db.withdrawals.filter(function (w) { return w.user_id === m.id && (w.status === "pending" || w.status === "approved"); }), function (w) { return w.amount; })),
                    min_withdraw: db.settings.min_withdraw
                };
            },

            my_referrals: function (db) {

                var m = needLoginRow(db), out = [];

                db.profiles.filter(function (p) { return p.referred_by === m.id; })
                    .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })
                    .forEach(function (p) {

                        var deps = db.deposits.filter(function (d) { return d.user_id === p.id; })
                            .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });

                        var name = ((p.first_name || "") + " " + (p.last_name || "")).trim();
                        var mail = maskEmail(p.email);

                        if (!deps.length) {
                            out.push({ r_name: name, r_email: mail, r_joined: p.created_at, r_plan: null, r_amount: null, r_commission: null, r_status: null });
                            return;
                        }

                        deps.forEach(function (d) {
                            var pl = db.plans.filter(function (x) { return x.id === d.plan_id; })[0];
                            out.push({
                                r_name: name, r_email: mail, r_joined: p.created_at,
                                r_plan: pl ? pl.name : d.plan_id, r_amount: d.amount,
                                r_commission: pl ? round2(d.amount * pl.referral_rate / 100) : 0,
                                r_status: d.status
                            });
                        });
                    });

                return out;
            },

            request_deposit: function (db, a) {

                var m = needLoginRow(db);
                var amount = a.p_amount;

                if (amount == null || isNaN(amount)) throw new Error("Please enter an amount");

                var pl = db.plans.filter(function (x) { return x.id === a.p_plan && x.active; })[0];
                if (!pl) throw new Error("Plan not found");

                if (amount < pl.min_amount || amount > pl.max_amount) {
                    throw new Error("For the " + pl.name + " plan, the amount must be between " + pl.min_amount + " and " + pl.max_amount);
                }

                var pending = db.deposits.filter(function (d) { return d.user_id === m.id && d.status === "pending"; }).length;
                if (pending >= 5) throw new Error("You already have 5 pending deposits. Please wait for approval.");

                var row = {
                    id: uid(), user_id: m.id, plan_id: pl.id, amount: round2(amount),
                    note: a.p_note ? String(a.p_note).slice(0, 200) : null,
                    status: "pending", created_at: nowIso(), reviewed_at: null, reviewed_by: null
                };

                db.deposits.push(row);
                return row.id;
            },

            request_withdrawal: function (db, a) {

                var m = needLoginRow(db);
                var amount = a.p_amount;

                if (amount == null || isNaN(amount)) throw new Error("Please enter an amount");

                if (amount < db.settings.min_withdraw) throw new Error("Minimum withdrawal is " + db.settings.min_withdraw);

                accrue(db, m.id);
                var bal = balanceOf(db, m.id);

                if (amount > bal) throw new Error("You can withdraw up to " + bal);

                var row = {
                    id: uid(), user_id: m.id, amount: round2(amount),
                    note: a.p_note ? String(a.p_note).slice(0, 200) : null,
                    status: "pending", created_at: nowIso(), reviewed_at: null, reviewed_by: null
                };

                db.withdrawals.push(row);
                return row.id;
            },

            admin_review_deposit: function (db, a) {

                needAdmin(db);
                var m = me(db);

                var d = db.deposits.filter(function (x) { return x.id === a.p_id; })[0];
                if (!d) throw new Error("Deposit not found");
                if (d.status !== "pending") throw new Error("This deposit was already reviewed");

                d.reviewed_at = nowIso();
                d.reviewed_by = m.id;

                if (!a.p_approve) { d.status = "rejected"; return null; }

                var pl = db.plans.filter(function (x) { return x.id === d.plan_id; })[0];
                d.status = "approved";

                db.investments.push({
                    id: uid(), user_id: d.user_id, deposit_id: d.id, plan_id: d.plan_id,
                    amount: d.amount, daily_rate: pl.daily_rate, duration_days: pl.duration_days,
                    start_date: today(), status: "running", created_at: nowIso()
                });

                var buyer = db.profiles.filter(function (p) { return p.id === d.user_id; })[0];

                if (buyer && buyer.referred_by && pl.referral_rate > 0) {
                    db.referral_earnings.push({
                        id: uid(), referrer_id: buyer.referred_by, referred_id: buyer.id, deposit_id: d.id,
                        rate: pl.referral_rate, amount: round2(d.amount * pl.referral_rate / 100), created_at: nowIso()
                    });
                }

                return null;
            },

            admin_review_withdrawal: function (db, a) {

                needAdmin(db);

                var w = db.withdrawals.filter(function (x) { return x.id === a.p_id && x.status === "pending"; })[0];
                if (!w) throw new Error("Withdrawal not found or already reviewed");

                w.status = a.p_approve ? "approved" : "rejected";
                w.reviewed_at = nowIso();
                w.reviewed_by = me(db).id;

                return null;
            },

            admin_update_plan: function (db, a) {

                needAdmin(db);

                var p = db.plans.filter(function (x) { return x.id === a.p_id; })[0];
                if (!p) throw new Error("Plan not found");
                if (!(a.p_min > 0) || a.p_max < a.p_min) throw new Error("Maximum must be at least the minimum");
                if (!(a.p_days > 0)) throw new Error("Days must be more than 0");

                p.min_amount = a.p_min; p.max_amount = a.p_max; p.duration_days = a.p_days;
                p.daily_rate = a.p_rate; p.referral_rate = a.p_ref; p.active = !!a.p_active;

                return null;
            },

            admin_update_settings: function (db, a) {
                needAdmin(db);
                db.settings.min_withdraw = a.p_min_withdraw;
                return null;
            },

            admin_stats: function (db) {
                needAdmin(db);
                return {
                    users:               db.profiles.filter(function (p) { return p.role === "user"; }).length,
                    pending_deposits:    db.deposits.filter(function (d) { return d.status === "pending"; }).length,
                    pending_withdrawals: db.withdrawals.filter(function (w) { return w.status === "pending"; }).length,
                    approved_deposits:   sum(db.deposits.filter(function (d) { return d.status === "approved"; }), function (d) { return d.amount; }),
                    profit_credited:     sum(db.profit_logs, function (l) { return l.amount; }),
                    referral_credited:   sum(db.referral_earnings, function (r) { return r.amount; })
                };
            }
        };


        /* ----- query builder:  from("table").select(...).eq(...).order(...) ----- */

        function splitTop(s) {
            var out = [], depth = 0, cur = "";
            for (var i = 0; i < s.length; i++) {
                var ch = s.charAt(i);
                if (ch === "(") depth++;
                if (ch === ")") depth--;
                if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
            }
            if (cur.trim()) out.push(cur.trim());
            return out;
        }

        function pick(row, cols) {
            var list = splitTop(cols || "*"), out = {};
            list.forEach(function (c) {
                if (c === "*") Object.keys(row).forEach(function (k) { out[k] = row[k]; });
                else out[c] = row[c];
            });
            return out;
        }

        function project(row, sel, db) {

            var out = {};

            splitTop(sel || "*").forEach(function (part) {

                var m = part.match(/^(\w+)(?:![\w]+)?\(([^)]*)\)$/);

                if (m) {
                    var rel = m[1];
                    var key = rel === "plans" ? row.plan_id : row.user_id;
                    var tbl = rel === "plans" ? db.plans : db.profiles;
                    var hit = tbl.filter(function (r) { return r.id === key; })[0];
                    out[rel] = hit ? pick(hit, m[2]) : null;
                } else if (part === "*") {
                    Object.keys(row).forEach(function (k) { out[k] = row[k]; });
                } else {
                    out[part] = row[part];
                }
            });

            return out;
        }

        function Query(table) {
            this.table = table;
            this.sel = "*";
            this.filters = [];
            this.ord = null;
            this.mode = null;
        }

        Query.prototype.select = function (s) { this.sel = s || "*"; return this; };
        Query.prototype.eq = function (c, v) { this.filters.push([c, v]); return this; };
        Query.prototype.order = function (c, o) { this.ord = { c: c, asc: !(o && o.ascending === false) }; return this; };
        Query.prototype.maybeSingle = function () { this.mode = "maybe"; return this; };
        Query.prototype.single = function () { this.mode = "one"; return this; };

        Query.prototype.run = function () {

            var db = load();
            var m = me(db);
            var admin = isAdmin(db);
            var t = this.table;

            var source = {
                profiles: db.profiles, plans: db.plans, settings: [db.settings], deposits: db.deposits,
                investments: db.investments, profit_logs: db.profit_logs,
                referral_earnings: db.referral_earnings, withdrawals: db.withdrawals
            }[t];

            if (!source) return { data: null, error: { message: "Unknown table: " + t } };

            var rows = source.filter(function (r) {
                if (t === "plans" || t === "settings") return true;
                if (!m) return false;
                if (admin) return true;
                if (t === "profiles") return r.id === m.id;
                if (t === "referral_earnings") return r.referrer_id === m.id;
                return r.user_id === m.id;
            });

            this.filters.forEach(function (f) {
                rows = rows.filter(function (r) { return r[f[0]] === f[1]; });
            });

            if (this.ord) {
                var c = this.ord.c, dir = this.ord.asc ? 1 : -1;
                rows = rows.slice().sort(function (a, b) {
                    if (a[c] === b[c]) return 0;
                    return (a[c] > b[c] ? 1 : -1) * dir;
                });
            }

            var sel = this.sel;
            var data = rows.map(function (r) { return project(copy(r), sel, db); });

            if (this.mode === "maybe") return { data: data[0] || null, error: null };
            if (this.mode === "one") return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: "No matching row" } };

            return { data: data, error: null };
        };

        Query.prototype.then = function (resolve, reject) {
            var result;
            try { result = this.run(); } catch (e) { result = { data: null, error: { message: String(e.message || e) } }; }
            return Promise.resolve(result).then(resolve, reject);
        };


        /* ----- auth: email code (shown on screen in local mode) ----- */

        var auth = {

            signInWithOtp: async function (a) {

                var email = lower(a.email);
                var o = a.options || {};
                var db = load();

                var exists = db.authUsers.some(function (u) { return u.email === email; });

                if (!exists && o.shouldCreateUser === false) {
                    return { data: null, error: { message: "Signups not allowed for otp" } };
                }

                var code = "";
                for (var i = 0; i < 6; i++) code += Math.floor(Math.random() * 10);

                otps[email] = { code: code, expires: Date.now() + 10 * 60000, tries: 0, meta: o.data || {} };

                return { data: { user: null, session: null, demoCode: code }, error: null };
            },

            verifyOtp: async function (a) {

                var email = lower(a.email);
                var o = otps[email];
                var bad = { data: null, error: { message: "Token has expired or is invalid" } };

                if (!o || Date.now() > o.expires || o.tries >= 5) return bad;

                o.tries++;

                if (String(a.token) !== o.code) return bad;

                delete otps[email];

                var db = load();
                var user = db.authUsers.filter(function (u) { return u.email === email; })[0];

                if (!user) {

                    var meta = o.meta || {};
                    var used = String(meta.referral_code || "").trim().toUpperCase();
                    var ref = used ? db.profiles.filter(function (p) { return p.referral_code === used; })[0] : null;
                    var first = db.profiles.length === 0;

                    user = { id: uid(), email: email };
                    db.authUsers.push(user);

                    db.profiles.push({
                        id: user.id, email: email,
                        first_name: String(meta.first_name || "").slice(0, 60),
                        last_name:  String(meta.last_name || "").slice(0, 60),
                        phone:      String(meta.phone || "").slice(0, 30),
                        referral_code: genCode(db),
                        referred_by: ref ? ref.id : null,
                        role: (first || ADMINS.indexOf(email) > -1) ? "admin" : "user",
                        created_at: nowIso()
                    });
                }

                save(db);
                localStorage.setItem(SESSION_KEY, user.id);

                return { data: { session: { user: { id: user.id, email: email } } }, error: null };
            },

            getSession: async function () {
                var db = load();
                var p = me(db);
                return { data: { session: p ? sessionOf(p) : null }, error: null };
            },

            signOut: async function () {
                localStorage.removeItem(SESSION_KEY);
                return { error: null };
            }
        };

        return {

            isLocal: true,
            auth: auth,

            from: function (table) { return new Query(table); },

            rpc: async function (name, args) {

                var fn = rpcs[name];
                if (!fn) return { data: null, error: { message: "Unknown function: " + name } };

                try {
                    var db = load();
                    var data = fn(db, args || {});
                    save(db);
                    return { data: data === undefined ? null : data, error: null };
                } catch (e) {
                    return { data: null, error: { message: String(e.message || e) } };
                }
            }
        };
    }
    /* LOCAL_BACKEND_END */


    /* ---------- styles for banner + OTP popup ---------- */

    function injectStyles() {

        var css =
            ".demo-banner{background:#fdf1d8;color:#8a5a0a;text-align:center;padding:8px 14px;font:600 12px/1.4 'Inter','Segoe UI',Arial,sans-serif;letter-spacing:.3px;border-bottom:1px solid rgba(168,106,12,.25)}" +
            ".setup-banner{background:#fde8e8;color:#b02a2a;text-align:center;padding:12px 14px;font:600 13px/1.5 'Inter','Segoe UI',Arial,sans-serif;border-bottom:1px solid rgba(214,69,69,.3)}" +

            ".otp-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(10,40,25,.55);backdrop-filter:blur(4px)}" +
            ".otp-box{width:100%;max-width:420px;padding:34px 30px;background:#fff;border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.35);text-align:center;font-family:var(--sans,'Inter','Segoe UI',Arial,sans-serif);color:var(--text,#10261b)}" +
            ".otp-icon{width:56px;height:56px;margin:0 auto 16px;border-radius:50%;background:#e1f5ea;color:#178a58;display:flex;align-items:center;justify-content:center;font-size:26px}" +
            ".otp-box h2{font-family:var(--serif,Georgia,serif);font-size:26px;margin-bottom:8px;font-weight:600}" +
            ".otp-sub{color:#4d6a5a;font-size:14px;margin-bottom:18px;line-height:1.5}" +
            ".otp-demo{margin-bottom:16px;padding:10px 12px;border-radius:10px;background:#fdf1d8;color:#a86a0c;font-size:13px;font-weight:600;line-height:1.5}" +
            ".otp-input{width:100%;padding:14px;border-radius:12px;border:1px solid rgba(18,70,45,.25);font-size:28px;font-weight:700;letter-spacing:10px;text-align:center;outline:none;font-family:inherit;color:#10261b;background:#fbfefc}" +
            ".otp-input:focus{border-color:#178a58;box-shadow:0 0 0 3px rgba(34,165,106,.18)}" +
            ".otp-msg{min-height:22px;margin:12px 0;font-size:13px;font-weight:600}" +
            ".otp-msg.err{color:#d64545}.otp-msg.ok{color:#178a58}" +
            ".otp-verify{width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#22a56a,#178a58);color:#fff;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit}" +
            ".otp-verify:disabled{opacity:.5;cursor:not-allowed}" +
            ".otp-row{display:flex;justify-content:space-between;margin-top:16px}" +
            ".otp-row button{background:none;border:none;color:#178a58;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit}" +
            ".otp-row button:disabled{color:#7b9588;cursor:not-allowed}";

        var st = document.createElement("style");
        st.textContent = css;
        document.head.appendChild(st);
    }

    function addBanner(text, cls) {
        var b = document.createElement("div");
        b.className = cls;
        b.textContent = text;
        document.body.insertBefore(b, document.body.firstChild);
    }

    function reveal() {
        document.documentElement.style.visibility = "";
    }


    /* ---------- OTP popup ---------- */

    // opts: { email, demoCode, send: () => Promise<{ok,error,demoCode}>, verify: (code) => Promise<{ok,error}> }
    function showOtpModal(opts) {

        return new Promise(function (resolve) {

            var overlay = document.createElement("div");
            overlay.className = "otp-overlay";

            overlay.innerHTML =
                '<div class="otp-box" role="dialog" aria-modal="true" aria-labelledby="otpTitle">' +
                    '<div class="otp-icon">✉</div>' +
                    '<h2 id="otpTitle">Verify your email</h2>' +
                    '<p class="otp-sub"></p>' +
                    '<div class="otp-demo" hidden></div>' +
                    '<form class="otp-form" novalidate>' +
                        '<input class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="------" aria-label="Verification code">' +
                        '<p class="otp-msg" role="alert"></p>' +
                        '<button type="submit" class="otp-verify">Verify</button>' +
                    '</form>' +
                    '<div class="otp-row">' +
                        '<button type="button" class="otp-resend">Resend code</button>' +
                        '<button type="button" class="otp-cancel">Cancel</button>' +
                    '</div>' +
                '</div>';

            document.body.appendChild(overlay);

            var sub    = overlay.querySelector(".otp-sub");
            var demo   = overlay.querySelector(".otp-demo");
            var form   = overlay.querySelector(".otp-form");
            var input  = overlay.querySelector(".otp-input");
            var msg    = overlay.querySelector(".otp-msg");
            var verify = overlay.querySelector(".otp-verify");
            var resend = overlay.querySelector(".otp-resend");
            var cancel = overlay.querySelector(".otp-cancel");
            var timer  = null;

            function setDemo(code) {
                if (code) {
                    demo.hidden = false;
                    demo.textContent = "LOCAL DEMO MODE: no email is sent. Your code is " + code;
                    sub.innerHTML = "Enter the code below for <b>" + esc(maskEmail(opts.email)) + "</b>.";
                } else {
                    demo.hidden = true;
                    sub.innerHTML = "We sent a code to <b>" + esc(maskEmail(opts.email)) + "</b>. Enter it below. Check your spam folder too.";
                }
            }

            function setMsg(text, ok) {
                msg.textContent = text || "";
                msg.className = "otp-msg " + (text ? (ok ? "ok" : "err") : "");
            }

            function close(result) {
                clearInterval(timer);
                document.removeEventListener("keydown", onKey);
                overlay.remove();
                resolve(result);
            }

            function onKey(e) { if (e.key === "Escape") close(false); }
            document.addEventListener("keydown", onKey);

            function cooldown() {

                var left = RESEND_SECONDS;
                clearInterval(timer);
                resend.disabled = true;
                resend.textContent = "Resend code (" + left + "s)";

                timer = setInterval(function () {
                    left--;
                    if (left <= 0) {
                        clearInterval(timer);
                        resend.disabled = false;
                        resend.textContent = "Resend code";
                    } else {
                        resend.textContent = "Resend code (" + left + "s)";
                    }
                }, 1000);
            }

            input.addEventListener("input", function () {
                input.value = input.value.replace(/[^0-9]/g, "");
            });

            form.addEventListener("submit", async function (e) {

                e.preventDefault();

                var code = input.value.trim();

                if (code.length < CODE_LENGTH) {
                    setMsg("Enter the " + CODE_LENGTH + "-digit code.", false);
                    return;
                }

                verify.disabled = true;
                setMsg("Checking...", true);

                var r = await opts.verify(code);

                if (r.ok) {
                    close(true);
                    return;
                }

                setMsg(r.error, false);
                input.value = "";
                verify.disabled = false;
                input.focus();
            });

            resend.addEventListener("click", async function () {

                resend.disabled = true;
                setMsg("Sending a new code...", true);

                var r = await opts.send();

                if (!r.ok) {
                    setMsg(r.error, false);
                    resend.disabled = false;
                    return;
                }

                setDemo(r.demoCode);
                setMsg("A new code was sent.", true);
                cooldown();
            });

            cancel.addEventListener("click", function () { close(false); });

            setDemo(opts.demoCode);
            cooldown();
            input.focus();
        });
    }


    /* ---------- client (Supabase or local) ---------- */

    var sb = null;

    async function getClient() {

        if (!useSupabase) {
            sb = createLocalClient({ adminEmails: LOCAL_ADMIN_EMAILS });
            root.sb = sb;
            return sb;
        }

        await loadScript(CDN);

        sb = root.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });

        root.sb = sb;
        return sb;
    }


    /* ---------- auth flows (used by register, login and admin pages) ---------- */

    async function otpFlow(email, createUser, meta) {

        async function send() {
            var r = await sb.auth.signInWithOtp({
                email: email,
                options: createUser ? { shouldCreateUser: true, data: meta } : { shouldCreateUser: false }
            });
            return r.error
                ? { ok: false, error: friendly(r.error) }
                : { ok: true, demoCode: r.data && r.data.demoCode };
        }

        var first = await send();
        if (!first.ok) return first;

        var verified = await showOtpModal({
            email: email,
            demoCode: first.demoCode,
            send: send,
            verify: async function (code) {
                var r = await sb.auth.verifyOtp({ email: email, token: code, type: "email" });
                return r.error ? { ok: false, error: friendly(r.error) } : { ok: true };
            }
        });

        return verified ? { ok: true } : { ok: false, cancelled: true, error: "Verification cancelled." };
    }

    async function register(d) {

        var firstName = String(d.firstName || "").trim();
        var lastName  = String(d.lastName || "").trim();
        var email     = lower(d.email);
        var phone     = String(d.phone || "").trim();
        var referral  = String(d.referral || "").trim().toUpperCase();

        if (!firstName || !lastName) return { ok: false, error: "Please enter your first and last name." };
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Please enter a valid email address." };
        if (phone.replace(/[^0-9]/g, "").length < 10) return { ok: false, error: "Please enter a valid phone number." };

        if (referral) {
            var chk = await sb.rpc("referral_code_exists", { p_code: referral });
            if (chk.error || !chk.data) return { ok: false, error: "Referral code not found. Check the code or leave it empty." };
        }

        return otpFlow(email, true, { first_name: firstName, last_name: lastName, phone: phone, referral_code: referral });
    }

    async function login(emailInput) {

        var email = lower(emailInput);

        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Please enter a valid email address." };

        return otpFlow(email, false, null);
    }

    async function logout() {
        try { if (sb) await sb.auth.signOut(); } catch (e) {}
        window.location.href = "login.html";
    }

    function showMsg(form, text, ok) {

        var box = form.querySelector(".app-msg");

        if (!box) {
            box = document.createElement("p");
            box.className = "app-msg";
            form.insertBefore(box, form.querySelector("button[type=submit]"));
        }

        box.className = "app-msg " + (ok ? "form-ok" : "form-error");
        box.textContent = text;
    }

    function bindForms() {

        var regForm = $("registerForm");

        if (regForm) {
            regForm.addEventListener("submit", async function (e) {

                e.preventDefault();

                var btn = regForm.querySelector("button[type=submit]");
                btn.disabled = true;

                try { await root.IPReady; } catch (err) {
                    showMsg(regForm, "Backend is not connected yet. Check app.js settings.", false);
                    btn.disabled = false;
                    return;
                }

                showMsg(regForm, "Sending your verification code...", true);

                var res = await register({
                    firstName: $("firstName").value,
                    lastName:  $("lastName").value,
                    email:     $("email").value,
                    phone:     $("phone").value,
                    referral:  $("referral").value
                });

                if (!res.ok) {
                    showMsg(regForm, res.error, false);
                    btn.disabled = false;
                    return;
                }

                showMsg(regForm, "Email verified. Your account is ready. Opening your dashboard...", true);
                setTimeout(function () { window.location.href = "dashboard.html"; }, 900);
            });
        }

        var loginForm = $("loginForm");

        if (loginForm) {
            loginForm.addEventListener("submit", async function (e) {

                e.preventDefault();

                var btn = loginForm.querySelector("button[type=submit]");
                btn.disabled = true;

                try { await root.IPReady; } catch (err) {
                    showMsg(loginForm, "Backend is not connected yet. Check app.js settings.", false);
                    btn.disabled = false;
                    return;
                }

                showMsg(loginForm, "Sending your login code...", true);

                var res = await login($("loginEmail").value);

                if (!res.ok) {
                    showMsg(loginForm, res.error, false);
                    btn.disabled = false;
                    return;
                }

                window.location.href = "dashboard.html";
            });
        }
    }


    /* ---------- start ---------- */

    injectStyles();

    addBanner(
        useSupabase
            ? "DEMO / SIMULATION: all balances are virtual. No real money is accepted or paid."
            : "DEMO / SIMULATION (local mode): all balances are virtual and saved only in this browser. No real money.",
        "demo-banner"
    );

    if (needLogin) document.documentElement.style.visibility = "hidden";

    bindForms();

    root.logout = logout;
    root.IPAuth = { register: register, login: login, logout: logout, showOtpModal: showOtpModal };

    // Pages wait for this:  IPReady.then(function (ctx) { ctx.sb, ctx.session, ctx.profile })
    root.IPReady = (async function () {

        try {
            await getClient();
        } catch (e) {
            addBanner("Could not connect to Supabase: " + e.message, "setup-banner");
            reveal();
            throw e;
        }

        var sess = (await sb.auth.getSession()).data.session;
        var profile = null;

        if (sess) {
            var p = await sb.from("profiles").select("*").eq("id", sess.user.id).maybeSingle();
            profile = p.data || null;
        }

        if (needLogin && !sess) {
            window.location.replace("login.html");
            return new Promise(function () {});   // never continues on this page
        }

        if (sess) {

            var fullName = profile ? (profile.first_name + " " + profile.last_name).trim() : sess.user.email;

            if ($("welcomeUser")) $("welcomeUser").textContent = "Hi, " + fullName;
            if ($("planUser"))    $("planUser").textContent = fullName;

            // Home page: show a Dashboard button instead of Register / Login
            var nav = document.querySelector(".nav-buttons");
            if (nav) nav.innerHTML = '<a href="dashboard.html" class="btn btn-primary">Dashboard</a>';
        }

        reveal();

        return { sb: sb, session: sess, profile: profile };

    })();

    root.IPReady.catch(function () {});

})();
