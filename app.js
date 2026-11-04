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

    // Cloudflare Turnstile (free CAPTCHA) SITE key. Leave "" to keep CAPTCHA off.
    // Turn it on ONLY after you also enabled CAPTCHA in Supabase (see the setup guide).
    var CAPTCHA_SITE_KEY = "";

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

        var raw = (err && (err.message || err.msg)) || "";
        var code = (err && (err.code || err.error_code)) || "";
        var m = raw || "Something went wrong. Please try again.";
        var out;

        if (/over_email_send_rate_limit|rate limit|security purposes|too many|only request this after/i.test(m + " " + code)) {
            out = "Too many requests. Please wait a few minutes and try again.";
        } else if (/signups? not allowed|user not found/i.test(m)) {
            out = "No account found with this email. Please register first.";
        } else if (/otp_expired|expired|token has expired|invalid/i.test(m + " " + code) && !/email address/i.test(m)) {
            out = "That code is wrong or has expired.";
        } else if (/failed to fetch|network/i.test(m)) {
            out = "Network problem. Check your internet connection.";
        } else if (/sending .*email|smtp/i.test(m)) {
            out = "The email could not be sent. The site email settings need attention.";
        } else {
            out = m;
        }

        try { console.error("[INVEXORA auth error]", err); } catch (e) {}

        // show the real reason in small brackets so problems are easy to find
        if (raw && out !== raw) out += " [" + raw + (code ? " | " + code : "") + "]";

        return out;
    }

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var s = document.createElement("script");
            var t = setTimeout(function () { if (!done) { done = true; s.remove(); reject(new Error("Timed out loading " + src)); } }, 9000);
            s.src = src;
            s.onload = function () { if (!done) { done = true; clearTimeout(t); resolve(); } };
            s.onerror = function () { if (!done) { done = true; clearTimeout(t); reject(new Error("Could not load the Supabase library.")); } };
            document.head.appendChild(s);
        });
    }

    function withTimeout(promise, ms, message) {
        return new Promise(function (resolve, reject) {
            var t = setTimeout(function () { reject(new Error(message)); }, ms);
            promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
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
                settings: { id: 1, min_withdraw: 5, return_principal: true, require_kyc_withdraw: false },
                tiers: [
                    { id: 1, name: "Bronze",  min_invested: 0,    min_referrals: 0 },
                    { id: 2, name: "Silver",  min_invested: 100,  min_referrals: 3 },
                    { id: 3, name: "Gold",    min_invested: 500,  min_referrals: 10 },
                    { id: 4, name: "Diamond", min_invested: 1000, min_referrals: 25 }
                ],
                kyc_submissions: [], kyc_files: {},
                deposits: [], investments: [], profit_logs: [], referral_earnings: [], withdrawals: [],
                audit_log: [], support_messages: [], site_content: [], banners: [],
                seq: 0
            };
        }

        function load() {
            try {
                var d = JSON.parse(localStorage.getItem(DB_KEY));
                if (d && d.plans && d.profiles) {
                    d.audit_log = d.audit_log || [];
                    d.support_messages = d.support_messages || [];
                    d.site_content = d.site_content || [];
                    d.banners = d.banners || [];
                    d.kyc_submissions = d.kyc_submissions || [];
                    d.kyc_files = d.kyc_files || {};
                    d.tiers = d.tiers || seed().tiers;
                    return d;
                }
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

        function audit(db, action, table, id, details) {
            var m = me(db);
            db.audit_log.push({ id: ++db.seq, admin_id: m ? m.id : null, action: action, target_table: table,
                                target_id: String(id), details: details || null, created_at: nowIso() });
        }

        var METHODS = ["Bank Transfer", "Crypto (USDT)", "Mobile Wallet"];

        function needLoginRow(db) {
            var m = me(db);
            if (!m) throw new Error("Please login first");
            return m;
        }

        function needAdmin(db) {
            if (!isAdmin(db)) throw new Error("Admins only");
        }

        /* ----- tiny "realtime" bus (same idea as Supabase Realtime, works across tabs) ----- */
        var bus = (typeof BroadcastChannel !== "undefined") ? new BroadcastChannel("inv_rt") : null;
        var channels = [];
        var selfId = uid();
        var outbox = [];      // events are sent only AFTER the data is saved, so listeners always find it

        function syncPresence(ch) {
            ch.handlers.forEach(function (h) { if (h.type === "presence" && h.filter && h.filter.event === "sync") h.cb(); });
        }

        function deliver(msg) {
            channels.slice().forEach(function (ch) {

                if (msg.k === "pg") {
                    var who = me(load());
                    if (!who) return;
                    if (who.role !== "admin" && msg.row.user_id !== who.id) return;     // same privacy rule as the server
                    ch.handlers.forEach(function (h) {
                        if (h.type !== "postgres_changes" || h.filter.table !== msg.table) return;
                        if (h.filter.event && h.filter.event !== "*" && h.filter.event !== msg.event) return;
                        if (h.filter.filter) {
                            var m = String(h.filter.filter).match(/^(\w+)=eq\.(.+)$/);
                            if (m && String(msg.row[m[1]]) !== m[2]) return;
                        }
                        h.cb({ eventType: msg.event, new: msg.row });
                    });
                    return;
                }

                if (msg.topic !== ch.name) return;

                if (msg.k === "bc") {
                    if (msg.from === selfId) return;
                    ch.handlers.forEach(function (h) {
                        if (h.type === "broadcast" && h.filter.event === msg.event) h.cb({ event: msg.event, payload: msg.payload });
                    });
                } else if (msg.k === "join")  { ch.state[msg.key] = msg.payload; syncPresence(ch); }
                else if (msg.k === "leave")   { delete ch.state[msg.key]; syncPresence(ch); }
                else if (msg.k === "who")     { if (ch.tracked && msg.from !== selfId) emit({ k: "join", topic: ch.name, key: ch.key, payload: ch.tracked }); }
            });
        }

        function emit(msg) {
            msg.from = selfId;
            try { if (bus) bus.postMessage(msg); } catch (e) {}
            deliver(msg);
        }

        if (bus) bus.onmessage = function (e) { if (e.data && e.data.from !== selfId) deliver(e.data); };

        try {
            window.addEventListener("pagehide", function () {
                channels.forEach(function (ch) { if (ch.tracked) { try { bus && bus.postMessage({ k: "leave", topic: ch.name, key: ch.key, from: selfId }); } catch (e) {} } });
            });
        } catch (e) {}

        function makeChannel(name, cfg) {
            var ch = { name: name, handlers: [], tracked: null, state: {},
                       key: (cfg && cfg.config && cfg.config.presence && cfg.config.presence.key) || uid() };
            ch.on = function (type, filter, cb) { ch.handlers.push({ type: type, filter: filter || {}, cb: cb }); return ch; };
            ch.subscribe = function (cb) {
                channels.push(ch);
                setTimeout(function () { if (cb) cb("SUBSCRIBED"); emit({ k: "who", topic: name }); }, 0);
                return ch;
            };
            ch.send = function (m) { emit({ k: "bc", topic: name, event: m.event, payload: m.payload || {} }); return Promise.resolve("ok"); };
            ch.track = function (p) { ch.tracked = p; emit({ k: "join", topic: name, key: ch.key, payload: p }); return Promise.resolve("ok"); };
            ch.presenceState = function () { var o = {}; Object.keys(ch.state).forEach(function (k) { o[k] = [ch.state[k]]; }); return o; };
            ch.unsubscribe = function () {
                channels = channels.filter(function (x) { return x !== ch; });
                if (ch.tracked) emit({ k: "leave", topic: name, key: ch.key });
                return Promise.resolve("ok");
            };
            return ch;
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

                if (m.suspended) throw new Error("Your account is suspended. Please contact support.");
                if (amount == null || isNaN(amount)) throw new Error("Please enter an amount");
                if (METHODS.indexOf(a.p_method) < 0) throw new Error("Please choose a payment method");

                var pl = db.plans.filter(function (x) { return x.id === a.p_plan && x.active; })[0];
                if (!pl) throw new Error("Plan not found");

                if (amount < pl.min_amount || amount > pl.max_amount) {
                    throw new Error("For the " + pl.name + " plan, the amount must be between " + pl.min_amount + " and " + pl.max_amount);
                }

                var pending = db.deposits.filter(function (d) { return d.user_id === m.id && d.status === "pending"; }).length;
                if (pending >= 5) throw new Error("You already have 5 pending deposits. Please wait for approval.");

                var row = {
                    id: uid(), user_id: m.id, plan_id: pl.id, amount: round2(amount),
                    payment_method: a.p_method,
                    note: a.p_note ? String(a.p_note).slice(0, 200) : null,
                    status: "pending", created_at: nowIso(), reviewed_at: null, reviewed_by: null
                };

                db.deposits.push(row);
                return row.id;
            },

            request_withdrawal: function (db, a) {

                var m = needLoginRow(db);
                var amount = a.p_amount;

                if (m.suspended) throw new Error("Your account is suspended. Please contact support.");
                if (db.settings.require_kyc_withdraw && m.kyc_status !== "approved") throw new Error("Please verify your account (Verification menu) before withdrawing");
                if (amount == null || isNaN(amount)) throw new Error("Please enter an amount");
                if (METHODS.indexOf(a.p_method) < 0) throw new Error("Please choose a payment method");

                if (amount < db.settings.min_withdraw) throw new Error("Minimum withdrawal is " + db.settings.min_withdraw);

                accrue(db, m.id);
                var bal = balanceOf(db, m.id);

                if (amount > bal) throw new Error("You can withdraw up to " + bal);

                var row = {
                    id: uid(), user_id: m.id, amount: round2(amount),
                    payment_method: a.p_method,
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

                if (!a.p_approve) {
                    d.status = "rejected";
                    audit(db, "deposit_rejected", "deposits", d.id, { user_id: d.user_id, amount: d.amount, plan: d.plan_id, method: d.payment_method });
                    return null;
                }

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

                audit(db, "deposit_approved", "deposits", d.id, { user_id: d.user_id, amount: d.amount, plan: d.plan_id, method: d.payment_method });
                return null;
            },

            admin_review_withdrawal: function (db, a) {

                needAdmin(db);

                var w = db.withdrawals.filter(function (x) { return x.id === a.p_id && x.status === "pending"; })[0];
                if (!w) throw new Error("Withdrawal not found or already reviewed");

                w.status = a.p_approve ? "approved" : "rejected";
                w.reviewed_at = nowIso();
                w.reviewed_by = me(db).id;

                audit(db, a.p_approve ? "withdrawal_approved" : "withdrawal_rejected", "withdrawals", w.id,
                      { user_id: w.user_id, amount: w.amount, method: w.payment_method });
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

                audit(db, "plan_updated", "plans", p.id, { min: a.p_min, max: a.p_max, days: a.p_days, daily_rate: a.p_rate, referral_rate: a.p_ref, active: !!a.p_active });
                return null;
            },

            admin_update_settings: function (db, a) {
                needAdmin(db);
                db.settings.min_withdraw = a.p_min_withdraw;
                audit(db, "settings_min_withdraw", "settings", 1, { min_withdraw: a.p_min_withdraw });
                return null;
            },

            admin_set_return_principal: function (db, a) {
                needAdmin(db);
                db.settings.return_principal = (a.p_value == null) ? true : !!a.p_value;
                audit(db, "settings_return_principal", "settings", 1, { return_principal: a.p_value });
                return null;
            },

            admin_set_suspended: function (db, a) {
                needAdmin(db);
                var t = db.profiles.filter(function (p) { return p.id === a.p_user; })[0];
                if (!t) throw new Error("User not found");
                if (t.role === "admin") throw new Error("An admin account cannot be suspended");
                t.suspended = !!a.p_suspended;
                t.suspended_at = a.p_suspended ? nowIso() : null;
                audit(db, a.p_suspended ? "user_suspended" : "user_unsuspended", "profiles", t.id, { email: t.email });
                return null;
            },

            admin_user_summary: function (db, a) {
                needAdmin(db);
                accrue(db, a.p_user);
                var id = a.p_user;
                return {
                    available:  balanceOf(db, id),
                    profit:     round2(sum(db.profit_logs.filter(function (l) { return l.user_id === id; }), function (l) { return l.amount; })),
                    referral:   round2(sum(db.referral_earnings.filter(function (r) { return r.referrer_id === id; }), function (r) { return r.amount; })),
                    active:     round2(sum(db.investments.filter(function (i) { return i.user_id === id && i.status === "running"; }), function (i) { return i.amount; })),
                    withdrawn:  round2(sum(db.withdrawals.filter(function (w) { return w.user_id === id && w.status === "approved"; }), function (w) { return w.amount; })),
                    pending_wd: round2(sum(db.withdrawals.filter(function (w) { return w.user_id === id && w.status === "pending"; }), function (w) { return w.amount; })),
                    deposited:  round2(sum(db.deposits.filter(function (d) { return d.user_id === id && d.status === "approved"; }), function (d) { return d.amount; }))
                };
            },

            send_support_message: function (db, a) {
                var m = needLoginRow(db);
                var txt = String(a.p_body == null ? "" : a.p_body).trim();
                if (txt.length < 1 || txt.length > 1000) throw new Error("Message must be between 1 and 1000 characters");
                var recent = db.support_messages.filter(function (x) {
                    return x.user_id === m.id && x.sender === "user" && (Date.now() - new Date(x.created_at).getTime()) < 600000;
                }).length;
                if (recent >= 10) throw new Error("You are sending messages too fast. Please wait a few minutes.");
                var row = { id: ++db.seq, user_id: m.id, sender: "user", body: txt, read_by_admin: false, read_by_user: true, created_at: nowIso() };
                db.support_messages.push(row);
                outbox.push({ k: "pg", table: "support_messages", event: "INSERT", row: copy(row) });
                return row.id;
            },

            mark_support_read: function (db) {
                var m = needLoginRow(db);
                db.support_messages.forEach(function (x) { if (x.user_id === m.id && x.sender === "admin") x.read_by_user = true; });
                return null;
            },

            admin_reply_support: function (db, a) {
                needAdmin(db);
                var txt = String(a.p_body == null ? "" : a.p_body).trim();
                if (txt.length < 1 || txt.length > 1000) throw new Error("Reply must be between 1 and 1000 characters");
                if (!db.profiles.some(function (p) { return p.id === a.p_user; })) throw new Error("User not found");
                var row = { id: ++db.seq, user_id: a.p_user, sender: "admin", body: txt, read_by_admin: true, read_by_user: false, created_at: nowIso() };
                db.support_messages.push(row);
                db.support_messages.forEach(function (x) { if (x.user_id === a.p_user && x.sender === "user") x.read_by_admin = true; });
                audit(db, "support_reply", "support_messages", row.id, { user_id: a.p_user });
                outbox.push({ k: "pg", table: "support_messages", event: "INSERT", row: copy(row) });
                return row.id;
            },

            admin_mark_support_read: function (db, a) {
                needAdmin(db);
                db.support_messages.forEach(function (x) { if (x.user_id === a.p_user && x.sender === "user") x.read_by_admin = true; });
                return null;
            },

            admin_set_content: function (db, a) {
                needAdmin(db);
                var allowed = ["home_label", "home_title_1", "home_title_2", "home_text", "home_btn1", "home_btn2", "steps_title", "step1_title", "step1_text", "step2_title", "step2_text", "step3_title", "step3_text", "step4_title", "step4_text", "about_label", "about_title", "about_text", "about_what_title", "about_what_text", "plans_label", "plans_title", "plans_text", "referral_label", "referral_title", "referral_text", "faq_label", "faq_title", "faq_text", "contact_label", "contact_title", "contact_text", "contact_email", "contact_hours", "privacy_label", "privacy_title", "privacy_text", "footer_tagline", "faq_items"];
                var items = a.p_items;
                if (!items || typeof items !== "object") throw new Error("Invalid content");
                var changed = [];
                Object.keys(items).forEach(function (k) {
                    if (allowed.indexOf(k) < 0) throw new Error("This text cannot be edited: " + k);
                    var v = String(items[k] == null ? "" : items[k]);
                    db.site_content = db.site_content.filter(function (r) { return r.key !== k; });
                    if (v.trim() !== "") {
                        if (k === "faq_items") {
                            var arr; try { arr = JSON.parse(v); } catch (e) { throw new Error("Invalid FAQ list"); }
                            if (!Array.isArray(arr) || v.length > 30000) throw new Error("Invalid FAQ list");
                        } else if (v.length > 2000) {
                            throw new Error("Text is too long (maximum 2000 characters): " + k);
                        }
                        db.site_content.push({ key: k, value: v, updated_at: nowIso() });
                    }
                    changed.push(k);
                });
                audit(db, "content_updated", "site_content", "", { keys: changed });
                return null;
            },

            admin_save_banner: function (db, a) {
                needAdmin(db);
                var msg = String(a.p_message == null ? "" : a.p_message).trim();
                var lt = String(a.p_link_text || "").trim() || null;
                var lu = String(a.p_link_url || "").trim() || null;
                var img = String(a.p_image_url || "").trim() || null;
                if (msg.length < 1 || msg.length > 300) throw new Error("The banner message must be 1 to 300 characters");
                if (lu && !/^(https?:\/\/\S+|[A-Za-z0-9_.\/#?=&-]+)$/.test(lu)) throw new Error("The link must start with http:// or https:// (or be a page like plans.html)");
                if (img && !/^(https:\/\/\S+|[A-Za-z0-9_.\/-]+)$/.test(img)) throw new Error("The image link must start with https://");
                if (a.p_starts && a.p_ends && a.p_ends < a.p_starts) throw new Error("The end date must be after the start date");
                var row = {
                    message: msg, link_text: lt, link_url: lu, style: a.p_style || "info", placement: a.p_placement || "top",
                    image_url: img, starts_at: a.p_starts || null, ends_at: a.p_ends || null,
                    active: a.p_active == null ? true : !!a.p_active, sort_order: Number(a.p_sort) || 0, updated_at: nowIso()
                };
                if (a.p_id == null) {
                    row.id = ++db.seq; row.created_at = nowIso();
                    db.banners.push(row);
                    audit(db, "banner_created", "banners", row.id, { message: msg.slice(0, 80) });
                    return row.id;
                }
                var ex = db.banners.filter(function (b) { return b.id === a.p_id; })[0];
                if (!ex) throw new Error("Banner not found");
                Object.keys(row).forEach(function (k) { ex[k] = row[k]; });
                audit(db, "banner_updated", "banners", ex.id, { message: msg.slice(0, 80), active: ex.active });
                return ex.id;
            },

            admin_delete_banner: function (db, a) {
                needAdmin(db);
                var n = db.banners.length;
                db.banners = db.banners.filter(function (b) { return b.id !== a.p_id; });
                if (db.banners.length === n) throw new Error("Banner not found");
                audit(db, "banner_deleted", "banners", a.p_id, null);
                return null;
            },

            submit_kyc: function (db, a) {
                var m = needLoginRow(db);
                var prefix = m.id + "/";
                var nm = String(a.p_full_name || "").trim();
                var num = String(a.p_doc_number || "").replace(/[\s-]/g, "").toUpperCase();
                if (m.kyc_status === "approved") throw new Error("Your account is already verified");
                if (m.kyc_status === "pending") throw new Error("Your verification is already under review");
                if (!a.p_consent) throw new Error("Please accept the consent box to continue");
                if (nm.length < 2 || nm.length > 100) throw new Error("Please enter your full name");
                var dob = a.p_dob ? new Date(a.p_dob + "T00:00:00") : null;
                var now = new Date();
                var limit18 = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate());
                var limit100 = new Date(now.getFullYear() - 100, now.getMonth(), now.getDate());
                if (!dob || isNaN(dob) || dob > limit18 || dob < limit100) throw new Error("You must be at least 18 years old (check your date of birth)");
                if (a.p_doc_type !== "nid" && a.p_doc_type !== "passport") throw new Error("Please choose NID or Passport");
                if (!/^[A-Z0-9]{4,30}$/.test(num)) throw new Error("Please enter a valid document number");
                function okPath(p) { return typeof p === "string" && p.indexOf(prefix) === 0 && p.indexOf("..") < 0; }
                if (!okPath(a.p_front)) throw new Error("The document photo is missing");
                if (a.p_doc_type === "nid" && !okPath(a.p_back)) throw new Error("Please add the back side of your NID");
                if (!okPath(a.p_selfie)) throw new Error("The live face photo is missing");
                var row = {
                    id: uid(), user_id: m.id, full_name: nm, date_of_birth: a.p_dob, doc_type: a.p_doc_type, doc_number: num,
                    doc_front_path: a.p_front, doc_back_path: a.p_doc_type === "nid" ? a.p_back : null, selfie_path: a.p_selfie,
                    status: "pending", reject_reason: null, consent_at: nowIso(), submitted_at: nowIso(), reviewed_at: null, reviewed_by: null
                };
                db.kyc_submissions.push(row);
                m.kyc_status = "pending";
                return row.id;
            },

            admin_review_kyc: function (db, a) {
                needAdmin(db);
                var k = db.kyc_submissions.filter(function (x) { return x.id === a.p_id; })[0];
                if (!k) throw new Error("Verification request not found");
                if (k.status !== "pending") throw new Error("This request was already reviewed");
                var reason = String(a.p_reason || "").trim();
                if (!a.p_approve && reason.length < 3) throw new Error("Please write a short reason for the user");
                k.status = a.p_approve ? "approved" : "rejected";
                k.reject_reason = a.p_approve ? null : reason.slice(0, 200);
                k.reviewed_at = nowIso(); k.reviewed_by = me(db).id;
                var u = db.profiles.filter(function (p) { return p.id === k.user_id; })[0];
                if (u) u.kyc_status = k.status;
                audit(db, a.p_approve ? "kyc_approved" : "kyc_rejected", "kyc_submissions", k.id, { user_id: k.user_id, reason: reason || null });
                return null;
            },

            admin_log_kyc_view: function (db, a) {
                needAdmin(db);
                var k = db.kyc_submissions.filter(function (x) { return x.id === a.p_id; })[0];
                if (k) audit(db, "kyc_viewed", "kyc_submissions", k.id, { user_id: k.user_id });
                return null;
            },

            admin_update_tier: function (db, a) {
                needAdmin(db);
                if (a.p_id === 1) throw new Error("The first level (Bronze) is for everyone and cannot be changed");
                if (!(a.p_min_invested > 0) || !(a.p_min_referrals > 0)) throw new Error("Both numbers must be more than 0");
                var t = db.tiers.filter(function (x) { return x.id === a.p_id; })[0];
                if (!t) throw new Error("Level not found");
                t.min_invested = a.p_min_invested; t.min_referrals = a.p_min_referrals;
                audit(db, "tier_updated", "tiers", t.id, { min_invested: a.p_min_invested, min_referrals: a.p_min_referrals });
                return null;
            },

            admin_set_require_kyc: function (db, a) {
                needAdmin(db);
                db.settings.require_kyc_withdraw = !!a.p_value;
                audit(db, "settings_require_kyc", "settings", 1, { require_kyc_withdraw: !!a.p_value });
                return null;
            },

            admin_support_threads: function (db) {
                needAdmin(db);
                var out = [];
                db.profiles.forEach(function (p) {
                    var msgs = db.support_messages.filter(function (x) { return x.user_id === p.id; });
                    if (!msgs.length) return;
                    var last = msgs[msgs.length - 1];
                    out.push({
                        t_user_id: p.id, t_name: ((p.first_name || "") + " " + (p.last_name || "")).trim(), t_email: p.email,
                        t_last: last.body, t_sender: last.sender, t_at: last.created_at,
                        t_unread: msgs.filter(function (x) { return x.sender === "user" && !x.read_by_admin; }).length
                    });
                });
                out.sort(function (a, b) { return (b.t_unread - a.t_unread) || (a.t_at < b.t_at ? 1 : -1); });
                return out;
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
        Query.prototype.limit = function (n) { this.lim = n; return this; };

        Query.prototype.run = function () {

            var db = load();
            var m = me(db);
            var admin = isAdmin(db);
            var t = this.table;

            var source = {
                profiles: db.profiles, plans: db.plans, settings: [db.settings], deposits: db.deposits,
                investments: db.investments, profit_logs: db.profit_logs,
                referral_earnings: db.referral_earnings, withdrawals: db.withdrawals,
                audit_log: db.audit_log, support_messages: db.support_messages,
                site_content: db.site_content, banners: db.banners,
                kyc_submissions: db.kyc_submissions, tiers: db.tiers
            }[t];

            if (!source) return { data: null, error: { message: "Unknown table: " + t } };

            var rows = source.filter(function (r) {
                if (t === "plans" || t === "settings" || t === "site_content") return true;
                if (t === "banners") {
                    if (admin) return true;
                    var nowIso_ = new Date().toISOString();
                    return !!r.active && (!r.starts_at || r.starts_at <= nowIso_) && (!r.ends_at || r.ends_at >= nowIso_);
                }
                if (!m) return false;
                if (t === "tiers") return true;
                if (t === "audit_log") return admin;
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

            if (this.lim) rows = rows.slice(0, this.lim);

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
                        suspended: false, suspended_at: null, kyc_status: "none",
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

            storage: {
                from: function (bucket) {
                    return {
                        upload: async function (path, blob, opts) {
                            var db = load(), m = me(db);
                            if (!m) return { data: null, error: { message: "Please login first" } };
                            if (path.indexOf(m.id + "/") !== 0) return { data: null, error: { message: "new row violates row-level security policy" } };
                            if (!blob || blob.size > 2097152) return { data: null, error: { message: "The file is too large (maximum 2 MB)" } };
                            if (["image/jpeg", "image/png"].indexOf(blob.type) < 0) return { data: null, error: { message: "mime type not supported" } };
                            if (db.kyc_files[path]) return { data: null, error: { message: "The resource already exists" } };
                            var dataUrl = await new Promise(function (res, rej) {
                                var fr = new FileReader();
                                fr.onload = function () { res(fr.result); };
                                fr.onerror = function () { rej(new Error("Could not read the file")); };
                                fr.readAsDataURL(blob);
                            });
                            db.kyc_files[path] = dataUrl;
                            save(db);
                            return { data: { path: path }, error: null };
                        },
                        createSignedUrl: async function (path) {
                            var db = load(), m = me(db);
                            if (!m || (m.role !== "admin" && path.indexOf(m.id + "/") !== 0)) return { data: null, error: { message: "Object not found" } };
                            var u = db.kyc_files[path];
                            return u ? { data: { signedUrl: u }, error: null } : { data: null, error: { message: "Object not found" } };
                        }
                    };
                }
            },

            channel: makeChannel,
            removeChannel: function (ch) { return ch && ch.unsubscribe ? ch.unsubscribe() : Promise.resolve("ok"); },

            from: function (table) { return new Query(table); },

            rpc: async function (name, args) {

                var fn = rpcs[name];
                if (!fn) return { data: null, error: { message: "Unknown function: " + name } };

                try {
                    var db = load();
                    var data = fn(db, args || {});
                    save(db);
                    while (outbox.length) emit(outbox.shift());
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
            ".demo-banner{background:rgba(255,196,71,.12);color:#ffc447;text-align:center;padding:8px 14px;font:600 12px/1.4 'Inter','Segoe UI',Arial,sans-serif;letter-spacing:.3px;border-bottom:1px solid rgba(255,196,71,.3)}" +
            ".setup-banner{background:rgba(255,107,107,.12);color:#ff8a8a;text-align:center;padding:12px 14px;font:600 13px/1.5 'Inter','Segoe UI',Arial,sans-serif;border-bottom:1px solid rgba(255,107,107,.3)}" +

            ".otp-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.72);backdrop-filter:blur(4px)}" +
            ".otp-box{width:100%;max-width:420px;padding:34px 30px;background:#111827;border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.6);text-align:center;font-family:var(--sans,'Inter','Segoe UI',Arial,sans-serif);color:var(--text,#f5f7fb)}" +
            ".otp-icon{width:56px;height:56px;margin:0 auto 16px;border-radius:50%;background:rgba(200,255,30,.14);color:#c8ff1e;display:flex;align-items:center;justify-content:center;font-size:26px}" +
            ".otp-box h2{font-family:var(--serif,Georgia,serif);font-size:26px;margin-bottom:8px;font-weight:600}" +
            ".otp-sub{color:#8b94a7;font-size:14px;margin-bottom:18px;line-height:1.5}" +
            ".otp-demo{margin-bottom:16px;padding:10px 12px;border-radius:10px;background:rgba(255,196,71,.12);color:#ffc447;font-size:13px;font-weight:600;line-height:1.5}" +
            ".otp-input{width:100%;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.18);font-size:28px;font-weight:700;letter-spacing:10px;text-align:center;outline:none;font-family:inherit;color:#f5f7fb;background:#0b0f19}" +
            ".otp-input:focus{border-color:#c8ff1e;box-shadow:0 0 0 3px rgba(200,255,30,.18)}" +
            ".otp-msg{min-height:22px;margin:12px 0;font-size:13px;font-weight:600}" +
            ".otp-msg.err{color:#ff6b6b}.otp-msg.ok{color:#c8ff1e}" +
            ".otp-verify{width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#d2ff3a,#b8f200);color:#1a2100;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit}" +
            ".otp-verify:disabled{opacity:.5;cursor:not-allowed}" +
            ".otp-row{display:flex;justify-content:space-between;margin-top:16px}" +
            ".otp-row button{background:none;border:none;color:#c8ff1e;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit}" +
            ".otp-row button:disabled{color:#5d667a;cursor:not-allowed}";

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
                        '<input class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="------" aria-label="Verification code">' +
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
                    setMsg("Enter the code from your email (at least " + CODE_LENGTH + " digits).", false);
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

        if (!root.supabase) {
            var urls = [CDN, "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js"];
            var lastErr = null;
            for (var i = 0; i < urls.length && !root.supabase; i++) {
                try { await loadScript(urls[i]); } catch (e) { lastErr = e; }
            }
            if (!root.supabase) throw (lastErr || new Error("Could not load the Supabase library."));
        }

        sb = root.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false,
                // run auth calls without the browser lock, which can freeze the page in some browsers
                lock: async function (name, acquireTimeout, fn) { return await fn(); }
            }
        });

        root.sb = sb;
        return sb;
    }


    /* ---------- CAPTCHA (Cloudflare Turnstile, optional) ---------- */

    var pageLoadedAt = Date.now();

    function captchaToken() {

        if (!CAPTCHA_SITE_KEY || !useSupabase) return Promise.resolve(undefined);

        function ready() {
            return new Promise(function (resolve, reject) {
                if (root.turnstile) { resolve(); return; }
                var s = document.createElement("script");
                s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
                s.async = true;
                s.onload = function () { resolve(); };
                s.onerror = function () { reject(new Error("Could not load the CAPTCHA.")); };
                document.head.appendChild(s);
            });
        }

        return ready().then(function () {
            return new Promise(function (resolve, reject) {

                var box = document.createElement("div");
                box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:10001";
                document.body.appendChild(box);

                var id, done = false;

                function finish(fn, val) {
                    if (done) return;
                    done = true;
                    setTimeout(function () { try { root.turnstile.remove(id); } catch (e) {} box.remove(); }, 400);
                    fn(val);
                }

                id = root.turnstile.render(box, {
                    sitekey: CAPTCHA_SITE_KEY,
                    appearance: "interaction-only",
                    callback: function (t) { finish(resolve, t); },
                    "error-callback": function () { finish(reject, new Error("CAPTCHA failed")); },
                    "timeout-callback": function () { finish(reject, new Error("CAPTCHA timed out")); }
                });

                setTimeout(function () { finish(reject, new Error("CAPTCHA timed out")); }, 60000);
            });
        });
    }

    // quick bot checks: a hidden field real people never fill, and a form that is "filled" too fast
    function botCheck(form) {
        var hp = form.querySelector('input[name="website"]');
        if (hp && hp.value) return "bot";
        if (Date.now() - pageLoadedAt < 2500) return "fast";
        return "";
    }


    /* ---------- auth flows (used by register, login and admin pages) ---------- */

    async function otpFlow(email, createUser, meta) {

        async function send() {

            var token;
            try { token = await captchaToken(); }
            catch (e) { return { ok: false, error: "The security check failed. Please refresh the page and try again." }; }

            var opts = createUser ? { shouldCreateUser: true, data: meta } : { shouldCreateUser: false };
            if (token) opts.captchaToken = token;

            var r = await sb.auth.signInWithOtp({ email: email, options: opts });
            return r.error
                ? { ok: false, error: friendly(r.error) }
                : { ok: true, demoCode: r.data && r.data.demoCode };
        }

        var first;
        try { first = await withTimeout(send(), 25000, "The server did not answer in time."); }
        catch (e) { return { ok: false, error: friendly(e) }; }
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

                var bc = botCheck(regForm);
                if (bc === "bot") return;
                if (bc === "fast") { showMsg(regForm, "Please wait a moment and try again.", false); return; }

                var btn = regForm.querySelector("button[type=submit]");
                btn.disabled = true;

                showMsg(regForm, "Connecting...", true);

                try { await withTimeout(root.IPReady, 20000, "timeout"); } catch (err) {
                    showMsg(regForm, "Could not connect to the server (" + (err && err.message ? err.message : "error") + "). Check your internet and refresh the page.", false);
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

                try { sessionStorage.setItem("inv_after_register", "1"); } catch (x) {}
                showMsg(regForm, "Email verified. Your account is ready. Opening your dashboard...", true);
                setTimeout(function () { window.location.href = "dashboard.html"; }, 900);
            });
        }

        var loginForm = $("loginForm");

        if (loginForm) {
            loginForm.addEventListener("submit", async function (e) {

                e.preventDefault();

                var bc = botCheck(loginForm);
                if (bc === "bot") return;
                if (bc === "fast") { showMsg(loginForm, "Please wait a moment and try again.", false); return; }

                var btn = loginForm.querySelector("button[type=submit]");
                btn.disabled = true;

                showMsg(loginForm, "Connecting...", true);

                try { await withTimeout(root.IPReady, 20000, "timeout"); } catch (err) {
                    showMsg(loginForm, "Could not connect to the server (" + (err && err.message ? err.message : "error") + "). Check your internet and refresh the page.", false);
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



    /* =====================================================
       SUPPORT CHAT  (user writes a message, an admin replies from the admin panel)
       ===================================================== */

    function initChat(sess) {

        if (document.body.hasAttribute("data-nochat") || document.body.classList.contains("auth-page")) return;

        var root_ = document.createElement("div");
        root_.className = "chat-root";
        root_.innerHTML =
            '<button type="button" class="chat-fab" aria-label="Open support chat">' +
                '<span class="chat-ico">💬</span><span class="chat-badge" hidden>0</span>' +
            '</button>' +
            '<div class="chat-panel" hidden role="dialog" aria-label="Support chat">' +
                '<div class="chat-head">' +
                    '<div><strong>INVEXORA Support</strong><small class="chat-status">Tell us your problem. An admin will reply here.</small></div>' +
                    '<button type="button" class="chat-close" aria-label="Close chat">×</button>' +
                '</div>' +
                '<div class="chat-body"></div>' +
                '<div class="chat-topics"></div>' +
                '<form class="chat-form" novalidate>' +
                    '<textarea rows="2" maxlength="1000" placeholder="Describe your problem..." aria-label="Your message"></textarea>' +
                    '<button type="submit" class="chat-send">Send</button>' +
                '</form>' +
                '<p class="chat-err" role="alert"></p>' +
            '</div>';
        document.body.appendChild(root_);

        var fab    = root_.querySelector(".chat-fab");
        var badge  = root_.querySelector(".chat-badge");
        var panel  = root_.querySelector(".chat-panel");
        var body   = root_.querySelector(".chat-body");
        var topics = root_.querySelector(".chat-topics");
        var form   = root_.querySelector(".chat-form");
        var input  = form.querySelector("textarea");
        var errBox = root_.querySelector(".chat-err");
        var msgs   = [];
        var busy   = false;
        var statusEl = root_.querySelector(".chat-status");
        var adminOnline = false;
        var typingUntil = 0;
        var lastTypingSent = 0;
        var botNoticeAfter = null;
        var rtChannel = null;
        var lastUnread = 0;
        var refreshSeq = 0;

        var GREETING = "Hi! 👋 Tell us about your problem (account, deposit, withdrawal, referral...). " +
                       "Our admin team will read your message and reply right here. You will see a red dot when there is a reply.";

        ["Account", "Deposit", "Withdrawal", "Referral", "Other"].forEach(function (t) {
            var b = document.createElement("button");
            b.type = "button"; b.className = "chat-topic"; b.textContent = t;
            b.addEventListener("click", function () {
                if (!input.value.trim()) input.value = "[" + t + "] ";
                input.focus();
            });
            topics.appendChild(b);
        });

        function fmt(d) {
            var x = new Date(d);
            return isNaN(x) ? "" : x.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
        }

        function render() {

            var html = '<div class="chat-msg them bot"><div class="chat-bubble">' + esc(GREETING) + '</div><div class="chat-meta">INVEXORA Bot</div></div>';

            if (!sess) {
                html += '<div class="chat-msg them bot"><div class="chat-bubble">Please log in to send a message. ' +
                        '<a href="login.html" class="chat-link">Login</a> or <a href="register.html" class="chat-link">Register</a></div></div>';
            }

            msgs.forEach(function (m) {
                var mine = m.sender === "user";
                html += '<div class="chat-msg ' + (mine ? "me" : "them") + '"><div class="chat-bubble">' + esc(m.body) + '</div>' +
                        '<div class="chat-meta">' + (mine ? "You" : "Support team") + ' · ' + esc(fmt(m.created_at)) + '</div></div>';
                if (botNoticeAfter != null && m.id === botNoticeAfter) {
                    html += '<div class="chat-msg them bot"><div class="chat-bubble">Thanks! Our team is offline right now. We will reply right here as soon as an admin sees your message.</div><div class="chat-meta">INVEXORA Bot</div></div>';
                }
            });

            if (Date.now() < typingUntil) {
                html += '<div class="chat-msg them"><div class="chat-bubble typing"><span></span><span></span><span></span></div><div class="chat-meta">Support team is typing...</div></div>';
            }

            body.innerHTML = html;
            body.scrollTop = body.scrollHeight;
        }

        function setStatus() {
            if (!sess) return;
            statusEl.innerHTML = adminOnline
                ? '<span class="chat-dot on"></span>Support team is online'
                : '<span class="chat-dot"></span>Offline now. Leave a message, we reply here.';
        }

        function setBadge(n) {
            badge.textContent = n > 9 ? "9+" : String(n);
            badge.hidden = !(n > 0) || !panel.hidden;
        }

        async function refresh() {

            if (!sess || busy) return;

            var mySeq = ++refreshSeq;

            var r = await sb.from("support_messages").select("*").order("id", { ascending: true });
            if (r.error || !r.data || mySeq !== refreshSeq) return;   // a newer check is already running: ignore this older answer

            var changed = r.data.length !== msgs.length;
            msgs = r.data;

            if (changed && msgs.length && msgs[msgs.length - 1].sender === "admin") typingUntil = 0;

            var unread = msgs.filter(function (m) { return m.sender === "admin" && !m.read_by_user; }).length;

            if (panel.hidden && unread > lastUnread) {
                fab.classList.add("ping");
                setTimeout(function () { fab.classList.remove("ping"); }, 3000);
            }
            lastUnread = unread;

            setBadge(unread);

            if (!panel.hidden) {
                if (changed || !body.innerHTML) render();
                if (unread > 0) {
                    await sb.rpc("mark_support_read");
                    msgs.forEach(function (m) { if (m.sender === "admin") m.read_by_user = true; });
                    setBadge(0);
                }
            }
        }

        function openPanel() {
            panel.hidden = false;
            badge.hidden = true;
            if (!sess) { form.hidden = true; topics.hidden = true; }
            render();
            refresh();
            if (sess) input.focus();
        }

        function closePanel() { panel.hidden = true; }

        fab.addEventListener("click", function () { panel.hidden ? openPanel() : closePanel(); });
        root_.querySelector(".chat-close").addEventListener("click", closePanel);

        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
        });

        form.addEventListener("submit", async function (e) {

            e.preventDefault();
            errBox.textContent = "";

            var text = input.value.trim();
            if (!text) return;
            if (!sess) { errBox.textContent = "Please log in first."; return; }

            busy = true;
            form.querySelector(".chat-send").disabled = true;

            var r = await sb.rpc("send_support_message", { p_body: text });

            busy = false;
            form.querySelector(".chat-send").disabled = false;

            if (r.error) { errBox.textContent = r.error.message; return; }

            input.value = "";
            await refresh();

            if (!adminOnline && msgs.length) botNoticeAfter = msgs[msgs.length - 1].id;

            render();
        });

        // tell the admin when the user is typing
        input.addEventListener("input", function () {
            if (!rtChannel || Date.now() - lastTypingSent < 2500) return;
            lastTypingSent = Date.now();
            try { rtChannel.send({ type: "broadcast", event: "typing", payload: { from: "user" } }); } catch (e) {}
        });

        function startRealtime() {

            try {

                var uid = sess.user.id;

                // new messages for THIS user arrive instantly; typing signals use the same private-by-name channel
                rtChannel = sb.channel("chat:" + uid)
                    .on("postgres_changes", { event: "INSERT", schema: "public", table: "support_messages", filter: "user_id=eq." + uid },
                        function () { refresh(); })
                    .on("broadcast", { event: "typing" }, function (p) {
                        if (p && p.payload && p.payload.from === "admin") {
                            typingUntil = Date.now() + 3500;
                            if (!panel.hidden) render();
                            setTimeout(function () { if (!panel.hidden && Date.now() >= typingUntil) render(); }, 3700);
                        }
                    })
                    .subscribe();

                // is an admin online right now?
                var pres = sb.channel("support-presence")
                    .on("presence", { event: "sync" }, function () {
                        var st = pres.presenceState();
                        adminOnline = Object.keys(st).length > 0;
                        setStatus();
                    })
                    .subscribe();

            } catch (e) {}
        }

        if (sess) {
            refresh();
            startRealtime();
            setStatus();
            // safety net: if live delivery is ever blocked, check again every 15 seconds
            setInterval(function () { if (!document.hidden) refresh(); }, 15000);
        }
    }



    /* =====================================================
       EDITABLE CONTENT + BANNERS  (managed from the admin panel)
       ===================================================== */

    var CMS_CONFIG = {"groups": [{"title": "Home page", "fields": [{"key": "home_label", "label": "Small label above the title", "type": "text", "def": "SMART INVESTMENT • BRIGHTER FUTURE"}, {"key": "home_title_1", "label": "Title, first line", "type": "text", "def": "Invest Today."}, {"key": "home_title_2", "label": "Title, second line (highlighted)", "type": "text", "def": "Build Your Future."}, {"key": "home_text", "label": "Intro paragraph", "type": "textarea", "def": "Explore structured investment plans and manage your financial journey through one simple platform."}, {"key": "home_btn1", "label": "Main button text", "type": "text", "def": "Create Account"}, {"key": "home_btn2", "label": "Second button text", "type": "text", "def": "Login"}]}, {"title": "How it works (home page)", "fields": [{"key": "steps_title", "label": "Section title", "type": "text", "def": "Start In Four Simple Steps"}, {"key": "step1_title", "label": "Step 1 title", "type": "text", "def": "Create Account"}, {"key": "step1_text", "label": "Step 1 text", "type": "textarea", "def": "Register with your basic details and verify your email with a one-time code."}, {"key": "step2_title", "label": "Step 2 title", "type": "text", "def": "Choose A Plan"}, {"key": "step2_text", "label": "Step 2 text", "type": "textarea", "def": "Review the available plans, compare duration and rates, then pick the one that fits."}, {"key": "step3_title", "label": "Step 3 title", "type": "text", "def": "Submit Deposit"}, {"key": "step3_text", "label": "Step 3 text", "type": "textarea", "def": "Enter a (virtual) amount and payment method. An admin reviews and approves your request."}, {"key": "step4_title", "label": "Step 4 title", "type": "text", "def": "Track & Withdraw"}, {"key": "step4_text", "label": "Step 4 text", "type": "textarea", "def": "Follow daily progress in your dashboard and request a (virtual) withdrawal any time."}]}, {"title": "About page", "fields": [{"key": "about_label", "label": "Small label", "type": "text", "def": "ABOUT INVEXORA"}, {"key": "about_title", "label": "Page title", "type": "text", "def": "A clear way to learn how investment plans work"}, {"key": "about_text", "label": "Intro text", "type": "textarea", "def": "INVEXORA is an investment platform that allows you to oversee the entire investment process—from sign-up all the way to fund withdrawal."}, {"key": "about_what_title", "label": "\"What we are\" title", "type": "text", "def": "What we are"}, {"key": "about_what_text", "label": "\"What we are\" paragraph", "type": "textarea", "def": "INVEXORA simulates the journey of an investment platform: choosing a plan, submitting a deposit, admin approval, daily profit tracking, referrals and withdrawals."}]}, {"title": "Plans page", "fields": [{"key": "plans_label", "label": "Small label", "type": "text", "def": "INVESTMENT PLANS"}, {"key": "plans_title", "label": "Page title", "type": "text", "def": "Choose a plan that fits your goal"}, {"key": "plans_text", "label": "Intro text", "type": "textarea", "def": "Compare the simulated plans below. Rates and durations are set by the platform and shown before you submit any deposit."}]}, {"title": "Referral page", "fields": [{"key": "referral_label", "label": "Small label", "type": "text", "def": "REFERRAL PROGRAM"}, {"key": "referral_title", "label": "Page title", "type": "text", "def": "Share your code, follow every referral"}, {"key": "referral_text", "label": "Intro text", "type": "textarea", "def": "Invite friends with your personal referral code. When a referred user's deposit is approved, a commission is added to your balance."}]}, {"title": "FAQ page", "fields": [{"key": "faq_label", "label": "Small label", "type": "text", "def": "FAQ"}, {"key": "faq_title", "label": "Page title", "type": "text", "def": "Frequently asked questions"}, {"key": "faq_text", "label": "Intro text", "type": "textarea", "def": "Quick answers about accounts, plans, deposits, withdrawals and referrals."}]}, {"title": "Contact page", "fields": [{"key": "contact_label", "label": "Small label", "type": "text", "def": "CONTACT"}, {"key": "contact_title", "label": "Page title", "type": "text", "def": "We are here to help"}, {"key": "contact_text", "label": "Intro text", "type": "textarea", "def": "Send us a message about your account, plans or anything on the site. We reply by email."}, {"key": "contact_email", "label": "Support email address (shown on the page and used by the form)", "type": "text", "def": "support@yourdomain.com"}, {"key": "contact_hours", "label": "Response time text", "type": "text", "def": "We aim to reply within one to two working days."}]}, {"title": "Privacy Policy page", "fields": [{"key": "privacy_label", "label": "Small label", "type": "text", "def": "PRIVACY POLICY"}, {"key": "privacy_title", "label": "Page title", "type": "text", "def": "How we handle your information"}, {"key": "privacy_text", "label": "Intro text", "type": "textarea", "def": "A plain-language explanation of what we collect, why we collect it and the choices you have."}]}, {"title": "Footer (all pages)", "fields": [{"key": "footer_tagline", "label": "Footer tagline", "type": "text", "def": "Smart tools for managing your investment journey."}]}], "faq": [{"q": "What is INVEXORA?", "a": "INVEXORA is a demo platform that simulates an investment website. You can register, choose a plan, submit a deposit, track daily profit, refer friends and request withdrawals, all with virtual balances."}, {"q": "Is real money involved?", "a": "No. All balances, profits and commissions are virtual. The site does not accept, hold or send real money."}, {"q": "How do I create an account?", "a": "Click Register, enter your name, email and phone, then type the one-time code sent to your email. Your account is ready right after verification."}, {"q": "How does login work?", "a": "Enter your email on the Login page. We send a one-time code to that address. Enter the code to sign in. There is no password to remember."}, {"q": "I did not receive my code. What should I do?", "a": "Check your spam folder, wait a minute and use Resend code. Make sure you typed the email correctly. Requesting too many codes in a short time can temporarily block new ones."}, {"q": "How do deposits work?", "a": "Choose a plan, enter an amount inside its range, pick a payment method and submit. An administrator reviews the request. When it is approved, your plan starts."}, {"q": "When is daily profit added?", "a": "After approval, the plan's daily rate is added to your balance once per day until the plan ends. You can follow each day in My Investments."}, {"q": "How do I withdraw?", "a": "Open the Withdraw tab in your dashboard, enter an amount up to your available balance (above the minimum) and submit. An administrator reviews the request."}, {"q": "How does the referral program work?", "a": "Share your code or link. When someone registers with it and their deposit is approved, a commission for that plan is added to your balance."}, {"q": "Can I change the plan after I start?", "a": "A running plan keeps its original terms. You can start another plan by submitting a new deposit."}, {"q": "Where can I get help?", "a": "Use the Contact page and we will reply by email."}]};
    root.INV_CMS = CMS_CONFIG;

    function safeUrl(u) {
        u = String(u || "").trim();
        if (!u) return "";
        if (/^https?:\/\/\S+$/i.test(u)) return u;
        if (/^[A-Za-z0-9_.\/#?=&-]+$/.test(u)) return u;
        return "";
    }

    function domReady() {
        return new Promise(function (resolve) {
            if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { resolve(); });
            else resolve();
        });
    }

    function dismissedList() {
        try { return JSON.parse(sessionStorage.getItem("inv_dismissed") || "[]"); } catch (e) { return []; }
    }

    function bannerLive(b) {
        var n = new Date().toISOString();
        return !!b.active && (!b.starts_at || b.starts_at <= n) && (!b.ends_at || b.ends_at >= n);
    }

    function renderBanners(list) {

        list = (list || []).filter(bannerLive).sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });

        var gone = dismissedList();

        // slim bars at the top of every page
        var tops = list.filter(function (b) { return b.placement === "top" && gone.indexOf(b.id) < 0; });

        if (tops.length) {

            var box = document.createElement("div");
            box.className = "site-banners";

            tops.forEach(function (b) {
                var link = safeUrl(b.link_url);
                var el = document.createElement("div");
                el.className = "site-banner " + (["info", "success", "warning", "promo"].indexOf(b.style) > -1 ? b.style : "info");
                el.innerHTML = '<span class="sb-text">' + esc(b.message) + '</span>' +
                    (link && b.link_text ? ' <a class="sb-link" href="' + esc(link) + '">' + esc(b.link_text) + '</a>' : '') +
                    '<button type="button" class="sb-close" aria-label="Close">×</button>';
                el.querySelector(".sb-close").addEventListener("click", function () {
                    var g = dismissedList(); g.push(b.id);
                    try { sessionStorage.setItem("inv_dismissed", JSON.stringify(g)); } catch (e) {}
                    el.remove();
                });
                box.appendChild(el);
            });

            var header = document.querySelector("header");
            if (header && header.parentNode) header.parentNode.insertBefore(box, header);
            else document.body.insertBefore(box, document.body.firstChild);
        }

        // bigger cards on the home page
        var homeBox = document.getElementById("homeBanners");
        var homes = list.filter(function (b) { return b.placement === "home"; });

        if (homeBox && homes.length) {
            homeBox.innerHTML = homes.map(function (b) {
                var link = safeUrl(b.link_url), img = String(b.image_url || "");
                var imgOk = /^https:\/\/\S+$/i.test(img) || /^[A-Za-z0-9_.\/-]+$/.test(img);
                return '<div class="home-banner ' + (["info", "success", "warning", "promo"].indexOf(b.style) > -1 ? b.style : "info") + '">' +
                    (img && imgOk ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : '') +
                    '<div class="hb-body"><p>' + esc(b.message) + '</p>' +
                    (link && b.link_text ? '<a class="btn btn-primary" href="' + esc(link) + '">' + esc(b.link_text) + '</a>' : '') +
                    '</div></div>';
            }).join("");
        }
    }

    function renderContent(content) {

        document.querySelectorAll("[data-cms]").forEach(function (el) {
            var v = content[el.getAttribute("data-cms")];
            if (v != null && String(v).trim() !== "") el.textContent = v;
        });

        var faqBox = document.getElementById("faqList");

        if (faqBox && content.faq_items) {
            try {
                var items = JSON.parse(content.faq_items);
                if (Array.isArray(items) && items.length) {
                    faqBox.innerHTML = items.filter(function (i) { return i && i.q; }).map(function (i) {
                        return '<details class="faq-item"><summary>' + esc(i.q) + '</summary><p>' + esc(i.a || "") + '</p></details>';
                    }).join("");
                }
            } catch (e) {}
        }

        root.INV_CMS_CONTENT = content;
        document.dispatchEvent(new CustomEvent("inv-cms-ready", { detail: content }));
    }

    async function applyCms() {

        if (document.body.hasAttribute("data-nochat")) return;   // not on the admin page

        await domReady();

        var data = null;

        try {
            var c = JSON.parse(sessionStorage.getItem("inv_cms") || "null");
            if (c && Date.now() - c.t < 30000) data = c;
        } catch (e) {}

        if (!data) {

            var a = await sb.from("site_content").select("key, value");
            var b = await sb.from("banners").select("*").order("sort_order", { ascending: true });

            data = { t: Date.now(), content: {}, banners: [] };

            if (!a.error && a.data) a.data.forEach(function (r) { data.content[r.key] = r.value; });
            if (!b.error && b.data) data.banners = b.data;

            try { sessionStorage.setItem("inv_cms", JSON.stringify(data)); } catch (e) {}
        }

        renderContent(data.content);
        renderBanners(data.banners);
    }


    // highest level whose numbers are reached: own approved investment OR number of referred people who invested
    root.INVTier = {
        compute: function (tiers, ownInvested, referredInvestors) {
            var list = (tiers || []).slice().sort(function (a, b) { return a.id - b.id; });
            var cur = list[0] || { id: 1, name: "Bronze" };
            list.forEach(function (t) {
                if (t.id === 1) return;
                if ((t.min_invested > 0 && ownInvested >= t.min_invested) || (t.min_referrals > 0 && referredInvestors >= t.min_referrals)) cur = t;
            });
            var next = list.filter(function (t) { return t.id > cur.id; })[0] || null;
            return { tier: cur, next: next };
        }
    };

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
            if (nav) {
                var tg = nav.querySelector(".nav-toggle");
                nav.innerHTML = '<a href="dashboard.html" class="btn btn-primary">Dashboard</a>';
                if (tg) nav.appendChild(tg);
            }
        }

        reveal();

        try { initChat(sess); } catch (e) { try { console.error(e); } catch (x) {} }
        try { applyCms().catch(function (e) { try { console.error(e); } catch (x) {} }); } catch (e) {}

        return { sb: sb, session: sess, profile: profile };

    })();

    root.IPReady.catch(function () {});

})();
