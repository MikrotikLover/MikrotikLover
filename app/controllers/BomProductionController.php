<?php
declare(strict_types=1);

/** BOM Production: raw materials (ink per colour, paper, chemicals) follow the design's BOM. */
final class BomProductionController extends ProductionController
{
    protected string $type = 'BOM';
    protected string $productionType = 'bom';

    protected function requirement(array $h, float $printed, callable $headerErr): array
    {
        $design = ProductionService::design((int) $h['design_id']);
        $req = [];
        foreach (ProductionService::inkRequirement($design, $printed) as $ink) {
            if ($ink['item'] === null) {
                $headerErr('design_id', Lang::t('production.no_ink_item', ['colour' => $ink['colour_code']]));
                continue;
            }
            $id = (int) $ink['item']['id'];
            $req[$id] = ['qty' => ($req[$id]['qty'] ?? 0) + (float) $ink['qty']];
        }
        foreach (ProductionService::bomRequirement($design, $printed) as $b) {
            $id = (int) $b['item']['id'];
            $req[$id] = ['qty' => ($req[$id]['qty'] ?? 0) + (float) $b['qty']];
        }
        return $req;
    }
}
