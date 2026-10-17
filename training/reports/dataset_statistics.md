# Dataset statistics — TURNITING_DATASET_V1

Built 2026-10-16T00:52:30Z from commit `b474bf9ee2`.

| metric | value |
|---|---:|
| rows_original | 2,204,463 |
| rows_valid | 2,195,128 |
| exact_duplicates_removed | 625,144 |
| near_duplicates_removed | 15,795 |
| label_conflicts | 10 |
| holdout_exclusions | 215,922 |
| kept_rows | 1,338,257 |
| human | 437,866 |
| machine | 885,273 |
| mixed | 15,118 |
| spanish | 76,540 |
| academic | 114,862 |
| groups | 1,020,386 |
| largest_group | 9,419 |

Invalid rows removed: `{'broken_html': 45, 'below_min_chars': 1766, 'below_min_words': 143, 'empty_or_whitespace': 7354, 'null': 27}`

## Splits

| split | rows | human | machine |
|---|---:|---:|---:|
| adversarial_test | 16,276 | 657 | 15,619 |
| adversarial_validation | 14,765 | 643 | 14,122 |
| mixed | 15,118 | 0 | 0 |
| ood_test | 44,406 | 18,671 | 25,735 |
| test | 201,824 | 89,539 | 112,285 |
| train | 865,590 | 274,192 | 591,398 |
| unseen_domain_test | 49,916 | 20,657 | 29,259 |
| unseen_generator_test | 36,468 | 0 | 36,468 |
| validation | 93,894 | 33,507 | 60,387 |

## Per dataset

| dataset | valid | exact dup | near dup | conflicts | holdout excl. | kept | human | machine | mixed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| autextification2023 | 107,769 | 0 | 1,104 | 0 | 0 | 106,665 | 51,251 | 55,414 | 0 |
| ghostbuster_essay | 6,994 | 0 | 0 | 0 | 0 | 6,994 | 994 | 6,000 | 0 |
| hc3 | 85,421 | 6,097 | 793 | 0 | 0 | 78,531 | 52,302 | 26,229 | 0 |
| hc3_chinese | 38,145 | 672 | 70 | 0 | 0 | 37,403 | 20,158 | 17,245 | 0 |
| iberautextification | 153,024 | 0 | 938 | 0 | 28,448 | 123,638 | 61,879 | 61,759 | 0 |
| m4 | 231,750 | 203,628 | 193 | 6 | 0 | 27,923 | 9,838 | 18,085 | 0 |
| mage | 436,606 | 829 | 11,022 | 0 | 45,081 | 379,674 | 123,671 | 256,003 | 0 |
| raid | 322,388 | 1,967 | 18 | 0 | 131,554 | 188,849 | 7,286 | 181,563 | 0 |
| semeval2024_task8 | 485,047 | 250,543 | 961 | 4 | 10,839 | 222,700 | 102,793 | 104,789 | 15,118 |
| turingbench | 327,984 | 161,408 | 696 | 0 | 0 | 165,880 | 7,694 | 158,186 | 0 |

## Languages

| value | human | machine |
|---|---:|---:|
| en | 311,924 | 756,215 |
| es | 37,566 | 38,974 |
| zh | 26,150 | 23,125 |
| pt | 12,238 | 10,957 |
| ca | 9,606 | 11,399 |
| eu | 6,780 | 8,178 |
| de | 5,979 | 5,999 |
| bg | 5,173 | 6,000 |
| gl | 5,448 | 5,254 |
| ru | 3,974 | 6,000 |
| ar | 4,001 | 4,100 |
| it | 3,037 | 3,038 |
| id | 2,990 | 3,005 |
| ur | 3,000 | 2,901 |
| la | 0 | 97 |
| fr | 0 | 13 |
| vi | 0 | 6 |
| no | 0 | 2 |
| rw | 0 | 2 |
| bn | 0 | 1 |
| he | 0 | 1 |
| ky | 0 | 1 |
| lt | 0 | 1 |
| pl | 0 | 1 |
| ro | 0 | 1 |
| sq | 0 | 1 |
| sw | 0 | 1 |

## Domains

| value | human | machine |
|---|---:|---:|
| news | 66,793 | 282,850 |
| forum | 94,215 | 114,471 |
| literary | 43,397 | 127,551 |
| wiki | 53,408 | 73,051 |
| academic | 30,801 | 84,061 |
| qa | 49,669 | 52,264 |
| howto | 27,273 | 25,659 |
| reviews | 20,439 | 27,253 |
| unknown | 18,109 | 25,135 |
| social | 15,154 | 15,611 |
| poetry | 1,145 | 27,780 |
| chat | 8,123 | 11,436 |
| legal | 8,922 | 9,955 |
| recipes | 218 | 7,596 |
| pubmed | 200 | 600 |

## Generator families

| value | human | machine |
|---|---:|---:|
| human | 437,866 | 0 |
| gpt | 0 | 283,435 |
| gpt-oss-older | 0 | 108,292 |
| opt | 0 | 73,826 |
| llama | 0 | 72,620 |
| t5 | 0 | 59,624 |
| mpt | 0 | 57,761 |
| bloom | 0 | 49,178 |
| grover | 0 | 25,179 |
| unknown | 0 | 25,135 |
| mistral | 0 | 20,991 |
| xlnet | 0 | 16,948 |
| fair-wmt | 0 | 16,461 |
| cohere | 0 | 15,477 |
| dolly | 0 | 14,044 |
| ai21 | 0 | 11,611 |
| xlm | 0 | 8,852 |
| glm | 0 | 8,416 |
| transformer-xl | 0 | 8,303 |
| ctrl | 0 | 8,120 |
| claude | 0 | 1,000 |

## Attacks

| value | human | machine |
|---|---:|---:|
| none | 431,178 | 717,377 |
| paraphrase | 608 | 16,829 |
| synonym | 610 | 15,317 |
| homoglyph | 608 | 15,267 |
| zero_width_space | 616 | 15,249 |
| whitespace | 608 | 15,229 |
| upper_lower | 607 | 15,169 |
| perplexity_misspelling | 605 | 15,076 |
| insert_paragraphs | 605 | 15,041 |
| number | 613 | 15,010 |
| article_deletion | 608 | 14,990 |
| alternative_spelling | 600 | 14,719 |

## Leakage checks

```json
{
  "groups_spanning_train_and_eval": 0,
  "exact_hashes_spanning_train_and_eval": 0,
  "near_duplicate_pairs_spanning_train_and_eval": 0,
  "result": "PASS"
}
```
