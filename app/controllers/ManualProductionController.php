<?php
declare(strict_types=1);

/** Manual Production: sampling, re-print and non-standard jobs; consumption entered by hand. */
final class ManualProductionController extends ProductionController
{
    protected string $type = 'MPV';
    protected string $productionType = 'manual';

    protected function headerRules(): array
    {
        return parent::headerRules() + ['manual_reason' => 'required|in:job,sampling,reprint,non_standard'];
    }
}
