# معمارية متجر موظفي بريدفاست (Phase 0)

## الفكرة
Frontend ثابت (Next.js static export) على Cloudflare Pages، وكل المنطق الحساس جوه Supabase.

```
المتصفح (Next.js static)  ──►  Supabase
   Cloudflare Pages              ├─ Auth (إيميل + تأكيد)
                                 ├─ Postgres: جداول + RLS + دوال (RPC) بـ transactions
                                 ├─ Edge Functions: بدء الدفع + Webhook بتاع Paymob
                                 ├─ pg_cron: إعادة توزيع 10 دقايق، تحرير الحجوزات المنتهية
                                 └─ Realtime: للمجهزين وموظفي الاستلام والأدمن وتتبع الطلب
```

## قواعد ثابتة
- الفلوس بالقروش (integer) — مفيش floating point.
- أي قاعدة تجارية (رسوم، حدود، مواعيد، بداية اليوم) في جداول قابلة للتعديل، مش في الكود.
- كل التوقيت بـ Africa/Cairo، والتخزين UTC.
- مفاتيح Paymob و service_role موجودة في Supabase Secrets فقط، أبدًا مش في GitHub ولا الـ frontend.
- الحماية الفعلية من RLS والدوال، مش من الـ frontend.

## حدود الـ Free Tier وحلولها
| الحد | الأثر | الحل |
|---|---|---|
| 200 اتصال Realtime متزامن | 300 موظف في الذروة يتخطوا الحد | الموظف مش بيفتح Realtime وهو بيتسوق. عداد المتصلين بـ heartbeat كل ~60 ثانية في جدول. Realtime للموظفين فقط في صفحة تتبع الطلب النشط، وللطاقم والأدمن |
| 5GB egress شهريًا | الصور والـ JSON | صور المنتجات من روابط خارجية، pagination، كاش للكتالوج |
| 500MB قاعدة بيانات | نمو السجلات | مراقبة الحجم + أرشفة لاحقًا |
| لا backups تلقائية | خطر على الفلوس والمحفظة | GitHub Actions يعمل pg_dump دوري (Phase 11) |
| إيقاف بعد 7 أيام خمول | ممكن يحصل بين المواسم | ping أسبوعي من GitHub Actions |
| ازدحام 300 طلب على نفس المنتج | قفل صفوف | دوال Postgres قصيرة، ترتيب قفل ثابت، اختبار حمل في Phase 10 |

## الجداول الأساسية (تتبني في Phase 2+)
profiles, employee_hrid_registry, employees, user_roles, role_permissions, categories, products,
stock_import_batches, stock_import_items, stock_movements, category_daily_limits,
employee_category_reservations, operating_days, time_slots, slot_reservations, orders, order_items,
order_assignments, order_status_history, bag_pricing, payments, refunds, wallets, wallet_transactions,
notifications, audit_logs, app_settings, presence_heartbeats.

## الخطة
الحالة: كل المراحل من 0 إلى 10 مكتملة في الكود. راجع `PROGRESS.md` و `docs/DEPLOY.md`.

قفل الصفوف (يمنع deadlocks): الموظف ← الطلب ← الموعد ← المنتجات (بترتيب id) ← المحفظة.
