<?php
declare(strict_types=1);

/**
 * Minimal router.
 *
 * Route options:
 *   auth    (bool, default true)   require a logged-in user
 *   perm    (string|string[])      require ANY of these permissions
 *   csrf    (bool, default: true for non-GET) require X-CSRF-Token
 *   pwd_ok  (bool, default false)  allowed while the user must change password
 *
 * Handlers are [ControllerClass, 'method']; {id} placeholders are passed as
 * int arguments. Whatever the handler returns is sent as {ok:true,data:...}.
 */
final class Router
{
    private array $routes = [];

    public function get(string $pattern, array $handler, array $options = []): self
    {
        return $this->add('GET', $pattern, $handler, $options);
    }

    public function post(string $pattern, array $handler, array $options = []): self
    {
        return $this->add('POST', $pattern, $handler, $options);
    }

    public function put(string $pattern, array $handler, array $options = []): self
    {
        return $this->add('PUT', $pattern, $handler, $options);
    }

    public function delete(string $pattern, array $handler, array $options = []): self
    {
        return $this->add('DELETE', $pattern, $handler, $options);
    }

    private function add(string $method, string $pattern, array $handler, array $options): self
    {
        $regex = '#^' . preg_replace('#\\\\\{[a-z_]+\\\\\}#', '(\d+)', preg_quote(trim($pattern, '/'), '#')) . '$#';
        $this->routes[] = compact('method', 'regex', 'handler', 'options');
        return $this;
    }

    public function dispatch(string $method, string $path): never
    {
        $allowed = [];
        foreach ($this->routes as $route) {
            if (!preg_match($route['regex'], $path, $m)) {
                continue;
            }
            if ($route['method'] !== $method) {
                $allowed[] = $route['method'];
                continue;
            }
            $this->guard($method, $route['options']);
            [$class, $action] = $route['handler'];
            $args = array_map('intval', array_slice($m, 1));
            $result = (new $class())->$action(...$args);
            Response::ok($result);
        }
        if ($allowed) {
            header('Allow: ' . implode(', ', array_unique($allowed)));
            throw new HttpException(405, Lang::t('error.method'), [], 'method_not_allowed');
        }
        throw new HttpException(404, Lang::t('error.route_not_found'), [], 'route_not_found');
    }

    private function guard(string $method, array $options): void
    {
        if ($options['csrf'] ?? ($method !== 'GET')) {
            Csrf::verify();
        }
        if (!($options['auth'] ?? true)) {
            return;
        }
        $user = Auth::user();
        if ($user === null) {
            $expired = !empty($_SESSION['_expired']);
            throw new HttpException(401, Lang::t($expired ? 'auth.expired' : 'auth.required'), [], 'unauthenticated');
        }
        Lang::set(Request::header('X-Lang') ?? $user['lang']);
        if ($user['must_change_password'] && !($options['pwd_ok'] ?? false)) {
            throw new HttpException(403, Lang::t('auth.must_change'), [], 'password_change_required');
        }
        if (isset($options['perm'])) {
            Auth::requirePermission($options['perm']);
        }
    }
}
