-- STAGING DEMO DATA ONLY. Every person here is fictional (example_ usernames, IDs 9000001+).
-- Never load this into a production database.
INSERT OR IGNORE INTO profiles (user_id, username, first_name, source, tags, notes, first_seen, last_seen) VALUES
 (9000001, 'example_asha', 'Asha (example)', 'promo_2', 'loyal,vip', 'Demo profile', strftime('%s','now','-40 days'), strftime('%s','now','-1 hours')),
 (9000002, 'example_priya', 'Priya (example)', '', '', '', strftime('%s','now','-30 days'), strftime('%s','now','-3 hours')),
 (9000003, 'example_rahul', 'Rahul (example)', 'promo_2', '', '', strftime('%s','now','-20 days'), strftime('%s','now','-1 days')),
 (9000004, 'example_neha', 'Neha (example)', '', 'trial', '', strftime('%s','now','-2 days'), strftime('%s','now','-5 hours'));
INSERT OR IGNORE INTO payments (telegram_payment_charge_id, user_id, plan, amount, currency, payload, created_at, status) VALUES
 ('example-charge-1', 9000001, 'monthly', 499, 'XTR', 'example', strftime('%s','now','-25 days'), 'accepted'),
 ('example-charge-2', 9000002, 'monthly', 499, 'XTR', 'example', strftime('%s','now','-12 days'), 'accepted'),
 ('example-charge-3', 9000004, 'trial', 49, 'XTR', 'example', strftime('%s','now','-1 days'), 'accepted');
INSERT OR IGNORE INTO trials (user_id, charge_id, starts_at, expires_at, joined_at, status) VALUES
 (9000004, 'example-charge-3', strftime('%s','now','-1 days'), strftime('%s','now','+2 days'), strftime('%s','now','-1 days'), 'active');
INSERT INTO member_events (user_id, event, invite_link_name, subscription_until, created_at)
 SELECT 9000001, 'joined_subscription', 'VIP Monthly 499', strftime('%s','now','+5 days'), strftime('%s','now','-25 days')
 WHERE NOT EXISTS (SELECT 1 FROM member_events WHERE user_id = 9000001);
INSERT INTO member_events (user_id, event, invite_link_name, subscription_until, created_at)
 SELECT 9000002, 'joined_subscription', 'VIP Monthly 499', strftime('%s','now','+18 days'), strftime('%s','now','-12 days')
 WHERE NOT EXISTS (SELECT 1 FROM member_events WHERE user_id = 9000002);
INSERT INTO captions (text) SELECT 'Good night from Shakhira ✨ (example)' WHERE NOT EXISTS (SELECT 1 FROM captions);
INSERT INTO captions (text) SELECT 'Morning vibes ☀️ (example)' WHERE (SELECT COUNT(*) FROM captions) = 1;
INSERT INTO join_requests (chat_id, user_id, username, first_name, requested_at)
 SELECT -1000000000001, 9000003, 'example_rahul', 'Rahul (example)', strftime('%s','now','-30 minutes')
 WHERE NOT EXISTS (SELECT 1 FROM join_requests);
INSERT INTO content_items (kind, target, text, options_json, close_after_minutes, status, scheduled_at, created_by, created_at, updated_at)
 SELECT 'poll', 'public', 'Which look next week? (example)', '["Red saree","Black dress","Denim"]', 1440, 'draft', NULL, 'demo',
        strftime('%s','now'), strftime('%s','now') WHERE NOT EXISTS (SELECT 1 FROM content_items);
INSERT INTO content_items (kind, target, text, status, created_by, created_at, updated_at)
 SELECT 'promo', 'public', '💎 VIP trial: 3 days for 49 ⭐ (example)', 'draft', 'demo', strftime('%s','now'), strftime('%s','now')
 WHERE (SELECT COUNT(*) FROM content_items) = 1;
