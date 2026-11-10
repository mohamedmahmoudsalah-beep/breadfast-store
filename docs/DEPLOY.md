# دليل الرفع والتشغيل (من الصفر لحد ما الموقع يشتغل)

كل الخطوات مجانية. الترتيب مهم، اتبعه زي ما هو. وقت التنفيذ المتوقع: ساعة لساعتين.

> **مهم:** النظام اتختبر بالكامل على قاعدة بيانات PostgreSQL حقيقية (40 اختبار) وبُني الموقع بنجاح، لكن الربط الفعلي مع حسابك على Supabase و Paymob و Cloudflare **لا يمكن اختباره غير بعد ما تعمل الخطوات دي**. لذلك الخطوة 9 (تجربة كاملة بـ Paymob Sandbox) **إجبارية** قبل ما تفتح للموظفين.

---

## 0) اللي هتحتاجه
- جهاز عليه **Node.js 22** و **Git** (حمّلهم من nodejs.org و git-scm.com).
- حسابات: GitHub، Supabase، Cloudflare، Paymob (الأربعة مسجلين عندك أو مجانيين).

## 1) ارفع الكود على GitHub
1. فك الـ ZIP، وافتح الفولدر `breadfast-store` في Terminal.
2. على GitHub اعمل repo جديد **Private** اسمه `breadfast-store` (لازم Private لأن النسخ الاحتياطية فيها بيانات موظفين).
3. نفّذ:
```bash
git init
git add .
git commit -m "Breadfast employee store"
git branch -M main
git remote add origin https://github.com/USERNAME/breadfast-store.git
git push -u origin main
```
4. شغّل الاختبارات محليًا للتأكد (اختياري لكنه مفيد):
```bash
npm install
npm test          # 40 اختبار: قاعدة البيانات + توقيع Paymob
npm run build     # لازم ينجح
```

## 2) Supabase: أنشئ المشروع
1. supabase.com ← **New project** ← اختار الخطة Free واسم `breadfast-store` وكلمة سر قوية للـ Database (**احفظها**) وأقرب Region.
2. من **Project Settings ← API** انسخ: `Project URL` و `anon public` key. (لا تستخدم `service_role` في أي مكان خارج Supabase.)

## 3) نفّذ ملفات قاعدة البيانات (Migrations)
**الطريقة الأسهل:** افتح **SQL Editor** في Supabase، وانسخ محتوى كل ملف من `supabase/migrations/` **بالترتيب** والصقه وشغّله (Run):
`0001_core.sql` ← `0002_catalog.sql` ← `0003_schedule.sql` ← `0004_orders_payments.sql` ← `0005_fulfillment.sql` ← `0006_admin_reports.sql` ← `0007_rls_grants.sql` ← `0008_admin_link.sql` ← `0009_changes.sql` ← `0010_price_sheet.sql`

(أو بالـ CLI: `npx supabase login` ثم `npx supabase link --project-ref YOUR_REF` ثم `npx supabase db push`.)

لو ظهرت ملاحظة إن `pg_cron` لم يتفعّل: من **Database ← Extensions** فعّل `pg_cron` ثم شغّل `supabase/seed/schedule_jobs.sql`. **ده ضروري** (بيشغّل كل دقيقة: إلغاء الطلبات غير المدفوعة + قاعدة الـ 10 دقايق + توزيع الطلبات).

## 4) إعدادات المصادقة (Authentication) ← مهم جدًا
1. **Authentication ← Providers ← Email**: فعّل Email، و **Confirm email = ON**، وخلي أقل طول لكلمة المرور 8.
2. **Authentication ← URL Configuration**: `Site URL` = رابط موقعك على Cloudflare (هتعرفه في الخطوة 7؛ ممكن ترجع تعدّله)، وفي **Redirect URLs** ضيف `https://YOUR-SITE.pages.dev/**`.
3. **⚠ البريد الإلكتروني:** خدمة البريد الافتراضية في Supabase محدودة جدًا (عدد قليل من الرسائل في الساعة)، ولن تكفي 350 موظف. حلّين:
   - **(أ) الأفضل:** **Authentication ← SMTP Settings** وفعّل SMTP مخصص مجاني: Brevo (300 رسالة/يوم) أو Resend أو Gmail بـ App Password.
   - **(ب)** تنشئ الحسابات بنفسك من لوحة الإدارة ← المستخدمون ← «إنشاء حساب» (من غير بريد تأكيد).

## 5) أول Super Admin
1. افتح الموقع (محليًا `npm run dev` أو بعد النشر) وسجّل حساب بإيميلك وأكّده.
2. في SQL Editor شغّل (بعد تغيير الإيميل): `select public.bootstrap_super_admin('your-email@example.com');`
3. اعمل Logout/Login. هيظهر لك قسم **الإدارة**.
4. لأن حسابك مش مربوط بـ HRID: ضيف نفسك في «المستخدمون ← سجل الموظفين» (أو من SQL) واربط الـ HRID بتاعك من صفحة الربط.

## 6) Paymob (ابدأ بـ Test)
1. ادخل Dashboard بتاع Paymob، وفي **أعلى اليسار** تأكد إن الوضع **Test** (للتجربة) — بعدين هتحوّله Live.
2. **Settings** (القائمة اليسار) ← قسم **Account Info**: انسخ **HMAC**، واضغط **View** جنب كل من **API Key** و **Secret Key** و **Public Key** وانسخهم.
3. **Developers ← Payment Integrations**: لازم تلاقي integration بتاع الكارت (Online Card). رقمه هو الـ **Integration ID**. لو مش موجود كلّم دعم Paymob.
4. افتح الـ Integration وحط في **Transaction processed callback**: `https://REF.supabase.co/functions/v1/paymob-webhook` (الكود بيبعته كمان مع كل عملية، ده تأمين زيادة).
5. اسأل Paymob: شروط تفعيل Live، العمولة، مدة التسوية، وهل الاسترداد/الإلغاء في نفس اليوم عبر الـ API.

## 7) انشر الـ Edge Functions (الدفع)
```bash
npx supabase login
npx supabase link --project-ref YOUR_REF
cp supabase/functions/.env.example supabase/functions/.env     # عدّل القيم (مفاتيح Paymob + SITE_URL)
npx supabase secrets set --env-file supabase/functions/.env
npx supabase functions deploy paymob-init
npx supabase functions deploy paymob-webhook --no-verify-jwt
npx supabase functions deploy process-refunds --no-verify-jwt
npx supabase functions deploy admin-create-user
```
`paymob-webhook` لازم `--no-verify-jwt` (Paymob بيناديه من الإنترنت، وحمايته بالتوقيع HMAC).

## 7.5) الاستردادات التلقائية (مرة واحدة)
الاستردادات على الكارت بتتبعت لـ Paymob **لوحدها** (فورًا + كل دقيقة). فعّل ده مرة واحدة من SQL Editor (بدّل القيمتين):
```sql
insert into app_private_config(key, value) values
  ('functions_url', 'https://REF.supabase.co/functions/v1'),
  ('cron_secret',   'نفس قيمة CRON_SECRET اللي حطيتها في Supabase Secrets')
on conflict (key) do update set value = excluded.value;
```
ولازم تفعّل الإضافة `pg_net` من **Database ← Extensions** لو مش مفعّلة. (لو تعطّل، `.github/workflows/refunds.yml` بيشتغل كاحتياطي كل 10 دقايق.)

## 8) Cloudflare (الموقع)
المشروع فيه ملف `wrangler.jsonc` جاهز (بيقول لـ Cloudflare ينشر فولدر `out` كملفات ثابتة). **لازم الملف ده يكون موجود في GitHub.**
1. Cloudflare ← **Workers & Pages ← Create ← Connect to Git** ← اختار `breadfast-store` (branch `main`).
2. Build command: `npm run build` — Deploy command: `npx wrangler deploy` (الافتراضي) — Root directory: سيبه فاضي.
3. **Variables** (لازم تتحط وقت الـ Build): `NEXT_PUBLIC_SUPABASE_URL` و `NEXT_PUBLIC_SUPABASE_ANON_KEY` و `NODE_VERSION=22`.
4. بعد النشر هتاخد رابط `https://breadfast-store.<اسمك>.workers.dev` (أو `.pages.dev`). حطه في Supabase (Site URL و Redirect URLs) وفي `SITE_URL` للـ Edge Functions.
5. افتح `/status/` وتأكد إن Supabase «متصل».

## 9) الإعداد الأولي من لوحة الإدارة (بالترتيب)
1. **الإعدادات:** رسوم الكيس المبدئية (10 ج)، رسوم المعالجة (1%)، بداية اليوم التجاري (08:00)، مهلة الدفع، **أسعار الأكياس الصغيرة والكبيرة الحقيقية** (القيم الحالية مؤقتة: 3 و 6 ج).
2. **المواعيد:** أيام العمل (الإثنين والخميس مفعّلين افتراضيًا) + مواعيد الاستلام وسعتها. (بداية الموعد لازم تكون بعد بداية اليوم التجاري.)
3. **المستخدمون:** ارفع ملف الموظفين (HRID + الاسم). اعمل حسابات المجهزين وموظفي الاستلام، ومن «إدارة» (Super Admin) اختار دورهم (مجهّز / موظف استلام). كل مجهّز يدخل صفحة «التجهيز» ويغيّر حالته لـ «متاح».
4. **الأقسام والحدود:** ضيف الحدود اليومية لكل موظف.
5. **رفع ملفات Excel** (لكل تبويب تمبليت جاهز تحمّله): (1) بيانات المنتجات: باركود/اسم/قسم/صورة (2) الأسعار: باركود/اسم/سعر (المنتج من غير سعر مخفي) (3) المخزون: باركود/اسم/كمية (إضافة) (4) حدود الأقسام. راجع المعاينة ثم أكّد.

## 10) تجربة كاملة قبل الإطلاق (إجباري)
جرّب بـ Paymob **Sandbox** وكروت الاختبار من Paymob:
- [ ] تسجيل موظف + إيميل تأكيد + ربط HRID.
- [ ] طلب → دفع ناجح → الطلب يتأكد تلقائيًا ويتعيّن لمجهّز.
- [ ] دفع فاشل ثم إعادة المحاولة من صفحة الطلب.
- [ ] إلغاء قبل التجهيز → يظهر استرداد → يتحول لـ «تم» (لو فشل تلقائيًا: «تم الرد يدويًا» من المدفوعات).
- [ ] مجهّز: مسح باركود + منتج «نفد» + أكياس → استرداد الفرق.
- [ ] موظف الاستلام: استلام من المجهّز ثم تسليم بالـ QR.
- [ ] أغلق صفحة الدفع في المنتصف وتأكد إن الطلب بيتلغي بعد المهلة ويرجع المخزون.
- [ ] من جهازين، نفس الموظف يضغط تأكيد معًا: لازم طلب واحد بس.
- [ ] (اختياري) `npm run test:concurrency` على مشروع Staging (التعليمات في أول الملف).

## 11) النسخ الاحتياطي والمراقبة (مجاني)
GitHub ← repo ← **Settings ← Secrets and variables ← Actions** ضيف:
`SUPABASE_DB_URL` (Connect ← Session pooler)، `SUPABASE_URL`، `SUPABASE_ANON_KEY`، `CRON_SECRET` (نفس قيمة الـ Edge secret).
- **backup.yml**: نسخة يومية للقاعدة (Artifact 30 يوم).
- **keepalive.yml**: يمنع إيقاف المشروع المجاني.
- **refunds.yml**: يدفع الاستردادات المعلقة لـ Paymob كل 10 دقايق.

## 12) الانتقال للإنتاج (Live)
1. فعّل حساب Paymob الحقيقي، وبدّل المفاتيح و Integration ID في `supabase secrets set` ثم أعد نشر الـ functions.
2. اعمل عملية حقيقية صغيرة بنفسك وتأكد من ظهورها في Paymob وفي «المدفوعات».
3. افتح للموظفين.

## حدود الخطة المجانية (راجعها قبل الإطلاق)
| الحد | التأثير | ملاحظة |
|---|---|---|
| 200 اتصال Realtime | الموظف العادي **لا** يفتح Realtime وهو بيتسوّق (عداد المتصلين بـ heartbeat) | المجهزون والاستلام والإدارة وتتبع الطلب النشط فقط يستخدموه |
| حجم قاعدة البيانات 500MB وبانوراما 5GB egress | كافي لموسم طويل بالاستخدام ده | راقب من Dashboard |
| بدون نسخ احتياطي تلقائي | خطر | فعّل backup.yml |
| Cloudflare Pages Free | استخدام تجاري مسموح، 500 build/شهر | مناسب |
لو حسيت بتباطؤ وقت الذروة (300 متزامن) فكّر في خطة Supabase Pro لأيام الذروة فقط.

## استكشاف الأخطاء
- **الموقع بيقول إعدادات ناقصة:** متغيرات Cloudflare مش مضافة، أضفها وأعد النشر.
- **الدفع مش بيأكد الطلب:** راجع Supabase ← Edge Functions ← `paymob-webhook` ← Logs. غالبًا HMAC مختلف أو Callback URL غلط.
- **الطلبات مش بتتوزع:** تأكد إن `pg_cron` شغال (`select * from cron.job;`) وإن المجهزين «متاح».
- **الإيميلات مش بتوصل:** فعّل SMTP مخصص (خطوة 4).
