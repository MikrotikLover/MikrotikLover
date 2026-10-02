<?php
declare(strict_types=1);

namespace App\Controllers;

/** ZKTeco devices allowed to push punches to /iclock/cdata (identified by serial number). */
final class DeviceController extends CrudController
{
    protected string $table = 'devices';
    protected string $label = 'Device';
    protected array $rules = [
        'serial_no' => 'required|string|max:50',
        'name'      => 'required|string|max:60',
        'location'  => 'nullable|string|max:100',
        'is_active' => 'bool',
    ];
    protected array $unique = ['serial_no' => 'Serial number'];
    protected array $searchable = ['serial_no', 'name', 'location'];

    protected function baseSelect(): string
    {
        return 'SELECT t.*, (SELECT COUNT(*) FROM attendance_punches p WHERE p.device_sn = t.serial_no) AS punch_count,
                       (SELECT MAX(p.punch_time) FROM attendance_punches p WHERE p.device_sn = t.serial_no) AS last_punch
                  FROM devices t';
    }
}
