<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Database;
use App\Request;

/** Audit trail viewer (read only): who changed what and when, with old / new values. */
final class AuditController
{
    private const PAGE = 100;

    private function filters(Request $r): array
    {
        $where = ['a.created_at >= :from', 'a.created_at < :to'];
        $from = (string)$r->query('from', '');
        $to = (string)$r->query('to', '');
        $from = preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) ? $from : date('Y-m-d', strtotime('-30 days'));
        $to = preg_match('/^\d{4}-\d{2}-\d{2}$/', $to) ? $to : date('Y-m-d');
        $params = ['from' => $from . ' 00:00:00', 'to' => date('Y-m-d', strtotime($to . ' +1 day')) . ' 00:00:00'];
        if ($u = $r->queryInt('user_id')) {
            $where[] = 'a.user_id = :u';
            $params['u'] = $u;
        }
        if (($e = (string)$r->query('entity', '')) !== '') {
            $where[] = 'a.entity = :e';
            $params['e'] = $e;
        }
        if (($ac = (string)$r->query('action', '')) !== '') {
            $where[] = 'a.action = :ac';
            $params['ac'] = $ac;
        }
        if ($id = $r->queryInt('entity_id')) {
            $where[] = 'a.entity_id = :id';
            $params['id'] = $id;
        }
        if (($q = (string)$r->query('q', '')) !== '') {
            // free text inside the changed values (e.g. an employee code or amount)
            $where[] = '(a.old_values LIKE :q1 OR a.new_values LIKE :q2 OR a.ip_address LIKE :q3)';
            $params += ['q1' => "%$q%", 'q2' => "%$q%", 'q3' => "%$q%"];
        }
        return [implode(' AND ', $where), $params];
    }

    public function index(Request $r): array
    {
        [$where, $params] = $this->filters($r);
        $page = max(1, (int)$r->queryInt('page', 1));
        $total = (int)Database::value("SELECT COUNT(*) FROM audit_log a WHERE $where", $params);
        $rows = Database::all(
            "SELECT a.id, a.created_at, a.user_id, u.username, u.full_name, a.action, a.entity, a.entity_id, a.ip_address,
                    LEFT(COALESCE(a.new_values, a.old_values), 300) AS summary
               FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
              WHERE $where ORDER BY a.id DESC LIMIT " . self::PAGE . ' OFFSET ' . (($page - 1) * self::PAGE),
            $params
        );
        return ['rows' => $rows, 'total' => $total, 'page' => $page, 'pages' => max(1, (int)ceil($total / self::PAGE))];
    }

    public function show(Request $r): array
    {
        $a = Database::one(
            'SELECT a.*, u.username, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ?',
            [$r->id()]
        ) ?? throw ApiException::notFound('Audit entry');
        $a['old_values'] = $a['old_values'] !== null ? json_decode($a['old_values'], true) : null;
        $a['new_values'] = $a['new_values'] !== null ? json_decode($a['new_values'], true) : null;
        return $a;
    }

    /** Values for the filter drop-downs. */
    public function facets(Request $r): array
    {
        return [
            'entities' => Database::column('SELECT DISTINCT entity FROM audit_log ORDER BY entity'),
            'actions' => Database::column('SELECT DISTINCT action FROM audit_log ORDER BY action'),
            'users' => Database::all('SELECT id, username, full_name FROM users ORDER BY username'),
        ];
    }

    /** Recent failed / successful logins (login_attempts keeps 30 days). */
    public function logins(Request $r): array
    {
        return Database::all(
            'SELECT username, ip_address, success, attempted_at FROM login_attempts ORDER BY id DESC LIMIT 200'
        );
    }
}
