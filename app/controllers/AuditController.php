<?php
declare(strict_types=1);

final class AuditController
{
    /** GET audit?date_from=&date_to=&user_id=&entity=&action=&q=&page=&per_page= */
    public function index(): array
    {
        [$page, $perPage, $offset] = Request::paging(50);
        $where = ['1 = 1'];
        $params = [];

        $from = (string) Request::query('date_from', '');
        $to = (string) Request::query('date_to', '');
        if ($from !== '' && Validator::isDate($from)) {
            $where[] = 'a.created_at >= :from';
            $params['from'] = $from . ' 00:00:00';
        }
        if ($to !== '' && Validator::isDate($to)) {
            $where[] = 'a.created_at <= :to';
            $params['to'] = $to . ' 23:59:59';
        }
        if (($userId = Request::queryInt('user_id')) > 0) {
            $where[] = 'a.user_id = :uid';
            $params['uid'] = $userId;
        }
        foreach (['entity', 'action'] as $field) {
            $value = (string) Request::query($field, '');
            if ($value !== '') {
                $where[] = "a.$field = :$field";
                $params[$field] = $value;
            }
        }
        $q = (string) Request::query('q', '');
        if ($q !== '') {
            $where[] = '(a.reference LIKE :q1 OR a.username LIKE :q2)';
            $like = '%' . addcslashes($q, '%_\\') . '%';
            $params += ['q1' => $like, 'q2' => $like];
        }

        $whereSql = implode(' AND ', $where);
        $total = (int) DB::value("SELECT COUNT(*) FROM audit_log a WHERE $whereSql", $params);
        $rows = DB::all(
            "SELECT a.id, a.user_id, a.username, a.action, a.entity, a.entity_id, a.reference,
                    a.old_values, a.new_values, a.ip, a.created_at
             FROM audit_log a WHERE $whereSql ORDER BY a.id DESC LIMIT :limit OFFSET :offset",
            $params + ['limit' => $perPage, 'offset' => $offset]
        );
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
            $row['old_values'] = $row['old_values'] !== null ? json_decode($row['old_values'], true) : null;
            $row['new_values'] = $row['new_values'] !== null ? json_decode($row['new_values'], true) : null;
        }
        unset($row);

        return [
            'items'    => $rows,
            'total'    => $total,
            'page'     => $page,
            'per_page' => $perPage,
            'entities' => DB::column('SELECT DISTINCT entity FROM audit_log ORDER BY entity'),
            'actions'  => DB::column('SELECT DISTINCT action FROM audit_log ORDER BY action'),
        ];
    }
}
