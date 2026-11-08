/** Maps database error codes (raised by the SQL functions) to Arabic messages. */
const messages: Record<string, string> = {
  NOT_AUTHENTICATED: "من فضلك سجّل الدخول.",
  FORBIDDEN: "ليس لديك صلاحية لهذا الإجراء.",
  ACCOUNT_DISABLED: "حسابك موقوف. تواصل مع الإدارة.",
  NOT_AN_EMPLOYEE: "حسابك غير مرتبط بموظف. اربط الـ HRID أولًا.",
  EMAIL_NOT_VERIFIED: "لازم تأكد بريدك الإلكتروني الأول.",
  ALREADY_LINKED: "حسابك مرتبط بـ HRID بالفعل.",
  HRID_INVALID: "الـ HRID غير صحيح أو غير موجود.",
  HRID_TAKEN: "الـ HRID ده مرتبط بحساب تاني.",
  RATE_LIMITED: "محاولات كتير. استنى شوية وجرب تاني.",
  INVALID_INPUT: "البيانات المدخلة غير صحيحة.",
  EMPTY_CART: "السلة فاضية.",
  INVALID_QTY: "الكمية غير صحيحة.",
  TOO_MANY_LINES: "عدد المنتجات في الطلب كبير جدًا.",
  PRODUCT_UNAVAILABLE: "أحد المنتجات لم يعد متاحًا.",
  INSUFFICIENT_STOCK: "الكمية المطلوبة أكبر من المتاح في المخزون.",
  CATEGORY_LIMIT_EXCEEDED: "تخطيت الحد اليومي المسموح لأحد الأقسام.",
  SLOT_UNAVAILABLE: "الموعد ده لم يعد متاحًا. اختار موعد تاني.",
  SLOT_FULL: "الموعد ده اكتمل. اختار موعد تاني.",
  STORE_CLOSED: "المتجر مقفول النهاردة أو خارج مواعيد الطلب.",
  PENDING_ORDER_EXISTS: "عندك طلب لسه مستني الدفع. كمّل دفعه أو الغيه الأول.",
  CANCEL_NOT_ALLOWED: "لا يمكن إلغاء الطلب لأن التجهيز بدأ.",
  ORDER_NOT_FOUND: "الطلب غير موجود.",
  ORDER_NOT_PAYABLE: "الطلب لا يقبل الدفع حاليًا.",
  PAYMENT_WINDOW_EXPIRED: "انتهت مهلة الدفع.",
  ALREADY_PAID: "الطلب مدفوع بالفعل.",
  TOO_MANY_ATTEMPTS: "عدد محاولات الدفع كبير. تواصل مع الإدارة.",
  NOT_ASSIGNED_TO_YOU: "الطلب ده مش معيّن ليك.",
  INVALID_STATE: "حالة الطلب لا تسمح بهذا الإجراء.",
  ITEM_NOT_IN_ORDER: "الباركود ده مش موجود في الطلب.",
  ITEM_ALREADY_DONE: "المنتج ده اتجهّز بالكامل.",
  ITEMS_NOT_FINISHED: "لسه فيه منتجات لم يتم تجهيزها أو تحديد توفرها.",
  BAGS_REQUIRED: "لازم تدخل عدد الأكياس الصغيرة والكبيرة.",
  CANNOT_REDUCE_UNAVAILABLE: "لا يمكن تقليل الكمية غير المتوفرة بعد تسجيلها.",
  NOT_READY: "الطلب لسه مش جاهز للاستلام.",
  EXTRA_PAYMENT_DUE: "في مبلغ إضافي لازم يتدفع قبل الاستلام.",
  ALREADY_COLLECTED: "الطلب اتسلّم قبل كده.",
  REASSIGN_NOT_ALLOWED: "لا يمكن إعادة تعيين الطلب في حالته الحالية.",
  REASON_REQUIRED: "لازم تكتب السبب.",
  INSUFFICIENT_WALLET: "رصيد المحفظة غير كافٍ.",
  EMPTY_FILE: "الملف فاضي.",
  FILE_TOO_LARGE: "الملف كبير جدًا (الحد الأقصى 5000 صف).",
  BATCH_NOT_PENDING: "الاستيراد ده اتأكد أو اتلغى قبل كده.",
  BATCH_HAS_INVALID_ROWS: "الملف فيه صفوف بها أخطاء. صحّحها وارفع الملف تاني.",
  DUPLICATE_BATCH: "الملف ده اتستورد قبل كده. أكد الاستيراد المكرر لو ده مقصود.",
  SLOT_BEFORE_BUSINESS_DAY_START: "بداية الموعد لازم تكون بعد بداية اليوم التجاري.",
  CANNOT_MODIFY_SELF: "لا يمكنك تعديل حسابك بنفسك.",
  PRODUCT_NOT_FOUND: "المنتج غير موجود.",
  IMAGE_URL_INVALID: "رابط الصورة لازم يبدأ بـ http أو https.",
};

export function errorCode(err: unknown): string {
  const e = err as { message?: string } | null;
  const msg = e?.message ?? "";
  const m = msg.match(/^[A-Z][A-Z_]+/);
  return m ? m[0] : msg;
}

export function errorMessage(err: unknown): string {
  const code = errorCode(err);
  if (messages[code]) return messages[code];
  if (/Failed to fetch|NetworkError/i.test(String((err as Error)?.message))) return "مفيش اتصال بالإنترنت أو بالسيرفر.";
  return "حصل خطأ غير متوقع. حاول تاني.";
}

export function errorDetail(err: unknown): string | undefined {
  return (err as { details?: string } | null)?.details ?? undefined;
}
