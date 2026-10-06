<?php
declare(strict_types=1);

namespace Prod;

/**
 * Streams rows from an .xlsx sheet with XMLReader, so a 40 MB sheet does not need 40 MB of DOM.
 * Needs only ZipArchive + XMLReader (both available on shared hosting).
 *
 * Cell values: numbers as float, text as string, booleans as bool, errors/empty as null.
 * Formulas give their last calculated value. Dates come as Excel serial numbers; use toDate().
 */
final class XlsxReader
{
    private \ZipArchive $zip;
    /** @var array<int,string> */
    private array $shared = [];
    /** @var array<string,string> sheet name => path inside the zip (worksheets only) */
    private array $sheets = [];
    private bool $date1904 = false;

    public function __construct(private string $path)
    {
        if (!class_exists(\ZipArchive::class) || !class_exists(\XMLReader::class)) {
            throw ApiException::validation(['file' => 'This server cannot read .xlsx files. Save the sheet as CSV and import that.']);
        }
        $this->zip = new \ZipArchive();
        if ($this->zip->open($path) !== true) {
            throw ApiException::validation(['file' => 'The file is not a valid .xlsx workbook.']);
        }
        $this->readWorkbook();
        $this->readSharedStrings();
    }

    /** @return string[] worksheet names in workbook order */
    public function sheetNames(): array
    {
        return array_keys($this->sheets);
    }

    private function readWorkbook(): void
    {
        $rels = [];
        $xml = $this->zip->getFromName('xl/_rels/workbook.xml.rels');
        if ($xml !== false) {
            $sx = simplexml_load_string($xml, \SimpleXMLElement::class, LIBXML_NONET);
            foreach ($sx->Relationship as $r) {
                if (str_ends_with((string)$r['Type'], '/worksheet')) {
                    $target = (string)$r['Target'];
                    $rels[(string)$r['Id']] = str_starts_with($target, '/') ? ltrim($target, '/') : 'xl/' . $target;
                }
            }
        }
        $xml = $this->zip->getFromName('xl/workbook.xml');
        if ($xml === false) {
            throw ApiException::validation(['file' => 'The file is not a valid .xlsx workbook.']);
        }
        $sx = simplexml_load_string($xml, \SimpleXMLElement::class, LIBXML_NONET);
        $this->date1904 = in_array(strtolower((string)($sx->workbookPr['date1904'] ?? '')), ['1', 'true'], true);
        foreach ($sx->sheets->sheet as $s) {
            $rid = (string)$s->attributes('http://schemas.openxmlformats.org/officeDocument/2006/relationships')['id'];
            if (isset($rels[$rid])) {
                $this->sheets[(string)$s['name']] = $rels[$rid];
            }
        }
    }

    private function readSharedStrings(): void
    {
        if ($this->zip->locateName('xl/sharedStrings.xml') === false) {
            return;
        }
        $r = new \XMLReader();
        $r->open('zip://' . $this->path . '#xl/sharedStrings.xml', null, LIBXML_NONET | LIBXML_COMPACT);
        while ($r->read()) {
            if ($r->nodeType === \XMLReader::ELEMENT && $r->localName === 'si') {
                $this->shared[] = $this->textOf($r, 'si');
            }
        }
        $r->close();
    }

    /** Concatenated <t> text of the current element (skips phonetic <rPh> runs). */
    private function textOf(\XMLReader $r, string $endTag): string
    {
        if ($r->isEmptyElement) {
            return '';
        }
        $text = '';
        $skip = 0;
        while ($r->read()) {
            if ($r->nodeType === \XMLReader::ELEMENT && $r->localName === 'rPh') {
                $skip++;
            } elseif ($r->nodeType === \XMLReader::END_ELEMENT && $r->localName === 'rPh') {
                $skip--;
            } elseif ($r->nodeType === \XMLReader::END_ELEMENT && $r->localName === $endTag) {
                break;
            } elseif (($r->nodeType === \XMLReader::TEXT || $r->nodeType === \XMLReader::CDATA || $r->nodeType === \XMLReader::WHITESPACE
                    || $r->nodeType === \XMLReader::SIGNIFICANT_WHITESPACE) && !$skip) {
                $text .= $r->value;
            }
        }
        return $text;
    }

    /**
     * Rows of a sheet: yields [rowNumber => [colIndex(0-based) => value]]. Empty rows are skipped.
     * @return \Generator<int,array<int,mixed>>
     */
    public function rows(string $sheet): \Generator
    {
        $file = $this->sheets[$sheet] ?? throw ApiException::validation(['sheet' => "Sheet \"$sheet\" not found."]);
        $r = new \XMLReader();
        $r->open('zip://' . $this->path . '#' . $file, null, LIBXML_NONET | LIBXML_COMPACT);
        $rowNo = 0;
        $row = [];
        $col = -1;
        while ($r->read()) {
            if ($r->nodeType === \XMLReader::ELEMENT) {
                if ($r->localName === 'row') {
                    $rowNo = (int)($r->getAttribute('r') ?: $rowNo + 1);
                    $row = [];
                    $col = -1;
                    if ($r->isEmptyElement) {
                        continue;
                    }
                } elseif ($r->localName === 'c') {
                    $ref = $r->getAttribute('r');
                    $col = $ref ? self::colIndex($ref) : $col + 1;
                    $type = $r->getAttribute('t') ?? 'n';
                    if ($r->isEmptyElement) {
                        continue;
                    }
                    $value = $this->cellValue($r, $type);
                    if ($value !== null && $value !== '') {
                        $row[$col] = $value;
                    }
                }
            } elseif ($r->nodeType === \XMLReader::END_ELEMENT && $r->localName === 'row') {
                if ($row) {
                    yield $rowNo => $row;
                }
                $row = [];
            }
        }
        $r->close();
    }

    private function cellValue(\XMLReader $r, string $type): mixed
    {
        $raw = null;
        $inline = null;
        while ($r->read()) {
            if ($r->nodeType === \XMLReader::END_ELEMENT && $r->localName === 'c') {
                break;
            }
            if ($r->nodeType === \XMLReader::ELEMENT && $r->localName === 'v') {
                $raw = $r->readString();
            } elseif ($r->nodeType === \XMLReader::ELEMENT && $r->localName === 'is') {
                $inline = $this->textOf($r, 'is');
            }
        }
        return match ($type) {
            's'         => $raw === null ? null : ($this->shared[(int)$raw] ?? null),
            'inlineStr' => $inline,
            'str'       => $raw,
            'b'         => $raw === null ? null : $raw === '1',
            'e'         => null,
            default     => ($raw === null || $raw === '' || !is_numeric($raw)) ? $raw : (float)$raw,
        };
    }

    public static function colIndex(string $ref): int
    {
        $n = 0;
        for ($i = 0, $len = strlen($ref); $i < $len; $i++) {
            $c = ord($ref[$i]);
            if ($c < 65 || $c > 90) {
                break;
            }
            $n = $n * 26 + ($c - 64);
        }
        return $n - 1;
    }

    /** Excel serial (1900 or 1904 system) -> Y-m-d, or null when out of a sane range. */
    public function toDate(float $serial): ?string
    {
        return self::serialToDate($serial, $this->date1904);
    }

    public static function serialToDate(float $serial, bool $date1904 = false): ?string
    {
        $days = (int)floor($serial);
        if ($days < 1 || $days > 2958465) {
            return null;
        }
        $base = $date1904 ? new \DateTimeImmutable('1904-01-01') : new \DateTimeImmutable('1899-12-30');
        return $base->modify("+$days days")->format('Y-m-d');
    }

    public function close(): void
    {
        $this->zip->close();
    }
}
