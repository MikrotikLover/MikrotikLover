<?php
declare(strict_types=1);

/**
 * Server-side messages in English and Urdu. The SPA sends X-Lang on every
 * request, so validation messages appear beside fields in the user's language.
 */
final class Lang
{
    private static ?string $lang = null;

    private const MESSAGES = [
        'en' => [
            'validation.failed'        => 'Please correct the highlighted fields.',
            'validation.required'      => 'This field is required.',
            'validation.string'        => 'Must be text.',
            'validation.max'           => 'Must be at most :max characters.',
            'validation.min'           => 'Must be at least :min characters.',
            'validation.min_value'     => 'Must be at least :min.',
            'validation.max_value'     => 'Must be at most :max.',
            'validation.integer'       => 'Must be a whole number.',
            'validation.numeric'       => 'Must be a number.',
            'validation.email'         => 'Enter a valid email address.',
            'validation.in'            => 'Select a valid option.',
            'validation.date'          => 'Enter a valid date (YYYY-MM-DD).',
            'validation.bool'          => 'Must be yes or no.',
            'validation.regex'         => 'Invalid format.',
            'validation.username'      => 'Use 3–50 letters, digits, dot, dash or underscore.',
            'validation.unique'        => 'This value is already in use.',
            'validation.exists'        => 'Selected record does not exist.',
            'validation.confirmed'     => 'Passwords do not match.',
            'validation.password'      => 'Password must be at least 8 characters and contain letters and numbers.',
            'validation.password_same' => 'New password must be different from the current one.',
            'auth.invalid'             => 'Invalid username or password.',
            'auth.inactive'            => 'Your account is inactive. Contact the administrator.',
            'auth.locked'              => 'Too many failed attempts. Try again in :minutes minutes.',
            'auth.required'            => 'Please log in to continue.',
            'auth.expired'             => 'Your session has expired. Please log in again.',
            'auth.current_wrong'       => 'Current password is incorrect.',
            'auth.must_change'         => 'You must change your password before continuing.',
            'auth.password_changed'    => 'Password changed successfully.',
            'auth.logged_out'          => 'Logged out.',
            'csrf.invalid'             => 'Security token expired. Please retry.',
            'error.forbidden'          => 'You do not have permission to do this.',
            'error.not_found'          => 'Record not found.',
            'error.route_not_found'    => 'Unknown API endpoint.',
            'error.method'             => 'Method not allowed.',
            'error.server'             => 'Something went wrong on the server. Please try again.',
            'error.bad_json'           => 'Invalid request body.',
            'error.constraint'         => 'This record is linked to other data or is a duplicate.',
            'error.db_not_configured'  => 'Database is not configured. Copy config.sample.php to the private folder as config.php.',
            'error.db_unavailable'     => 'Database is unavailable. Please try again shortly.',
            'setup.done'               => 'Setup already completed.',
            'setup.bad_key'            => 'Setup key is incorrect.',
            'user.self_deactivate'     => 'You cannot deactivate or delete your own account.',
            'user.last_admin'          => 'At least one active Admin must remain.',
            'role.admin_locked'        => 'Admin permissions cannot be changed.',
            'saved'                    => 'Saved successfully.',
            'deleted'                  => 'Deleted successfully.',
        ],
        'ur' => [
            'validation.failed'        => 'براہ کرم نشان زدہ خانے درست کریں۔',
            'validation.required'      => 'یہ خانہ ضروری ہے۔',
            'validation.string'        => 'متن درج کریں۔',
            'validation.max'           => 'زیادہ سے زیادہ :max حروف۔',
            'validation.min'           => 'کم از کم :min حروف۔',
            'validation.min_value'     => 'کم از کم :min ہونا چاہیے۔',
            'validation.max_value'     => 'زیادہ سے زیادہ :max ہونا چاہیے۔',
            'validation.integer'       => 'مکمل عدد درج کریں۔',
            'validation.numeric'       => 'عدد درج کریں۔',
            'validation.email'         => 'درست ای میل درج کریں۔',
            'validation.in'            => 'درست انتخاب کریں۔',
            'validation.date'          => 'درست تاریخ درج کریں۔',
            'validation.bool'          => 'ہاں یا نہیں منتخب کریں۔',
            'validation.regex'         => 'غلط فارمیٹ۔',
            'validation.username'      => '3 سے 50 انگریزی حروف، ہندسے، ڈاٹ، ڈیش یا انڈر اسکور۔',
            'validation.unique'        => 'یہ پہلے سے استعمال میں ہے۔',
            'validation.exists'        => 'منتخب ریکارڈ موجود نہیں۔',
            'validation.confirmed'     => 'پاس ورڈ مماثل نہیں۔',
            'validation.password'      => 'پاس ورڈ کم از کم 8 حروف کا ہو اور اس میں حروف اور ہندسے دونوں ہوں۔',
            'validation.password_same' => 'نیا پاس ورڈ پرانے سے مختلف ہونا چاہیے۔',
            'auth.invalid'             => 'یوزر نیم یا پاس ورڈ غلط ہے۔',
            'auth.inactive'            => 'آپ کا اکاؤنٹ غیر فعال ہے۔ ایڈمن سے رابطہ کریں۔',
            'auth.locked'              => 'بہت زیادہ ناکام کوششیں۔ :minutes منٹ بعد دوبارہ کوشش کریں۔',
            'auth.required'            => 'جاری رکھنے کے لیے لاگ اِن کریں۔',
            'auth.expired'             => 'سیشن ختم ہو گیا۔ دوبارہ لاگ اِن کریں۔',
            'auth.current_wrong'       => 'موجودہ پاس ورڈ غلط ہے۔',
            'auth.must_change'         => 'جاری رکھنے سے پہلے پاس ورڈ تبدیل کریں۔',
            'auth.password_changed'    => 'پاس ورڈ تبدیل ہو گیا۔',
            'auth.logged_out'          => 'لاگ آؤٹ ہو گئے۔',
            'csrf.invalid'             => 'سیکیورٹی ٹوکن ختم ہو گیا۔ دوبارہ کوشش کریں۔',
            'error.forbidden'          => 'آپ کو اس کی اجازت نہیں۔',
            'error.not_found'          => 'ریکارڈ نہیں ملا۔',
            'error.route_not_found'    => 'نامعلوم API۔',
            'error.method'             => 'یہ طریقہ قابل قبول نہیں۔',
            'error.server'             => 'سرور میں خرابی۔ دوبارہ کوشش کریں۔',
            'error.bad_json'           => 'غلط درخواست۔',
            'error.constraint'         => 'یہ ریکارڈ دوسرے ڈیٹا سے منسلک ہے یا دہرا ہے۔',
            'error.db_not_configured'  => 'ڈیٹا بیس سیٹ نہیں۔ config.sample.php کو پرائیویٹ فولڈر میں config.php کے نام سے رکھیں۔',
            'error.db_unavailable'     => 'ڈیٹا بیس دستیاب نہیں۔ کچھ دیر بعد کوشش کریں۔',
            'setup.done'               => 'سیٹ اپ پہلے ہی مکمل ہے۔',
            'setup.bad_key'            => 'سیٹ اپ کی غلط ہے۔',
            'user.self_deactivate'     => 'آپ اپنا اکاؤنٹ غیر فعال یا حذف نہیں کر سکتے۔',
            'user.last_admin'          => 'کم از کم ایک فعال ایڈمن ہونا ضروری ہے۔',
            'role.admin_locked'        => 'ایڈمن کی اجازتیں تبدیل نہیں ہو سکتیں۔',
            'saved'                    => 'محفوظ ہو گیا۔',
            'deleted'                  => 'حذف ہو گیا۔',
        ],
    ];

    public static function set(string $lang): void
    {
        self::$lang = $lang === 'ur' ? 'ur' : 'en';
    }

    public static function current(): string
    {
        if (self::$lang === null) {
            $header = strtolower((string) Request::header('X-Lang'));
            self::$lang = $header === 'ur' ? 'ur' : 'en';
        }
        return self::$lang;
    }

    public static function t(string $key, array $vars = []): string
    {
        $text = self::MESSAGES[self::current()][$key] ?? self::MESSAGES['en'][$key] ?? $key;
        foreach ($vars as $name => $value) {
            $text = str_replace(':' . $name, (string) $value, $text);
        }
        return $text;
    }
}
